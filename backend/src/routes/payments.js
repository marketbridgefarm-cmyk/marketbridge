const express=require('express');
const crypto=require('crypto');
const {body,param,validationResult}=require('express-validator');
const prisma=require('../config/db');
const {authenticate}=require('../middleware/auth');
const {isAdmin,isOrderParticipant}=require('../utils/authorization');
const {commissionFor}=require('../config/commissions');
const chapa=require('../config/chapa');
const router=express.Router();
const validate=(req,res,next)=>{const e=validationResult(req);if(!e.isEmpty())return res.status(400).json({error:'Validation failed',errors:e.array()});next();};
function timingSafeEqual(a,b){const x=Buffer.from(a||'','utf8'),y=Buffer.from(b||'','utf8');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function verifySignature(req){const secret=process.env.PAYMENT_WEBHOOK_SECRET;if(!secret)return false;const raw=req.rawBody || Buffer.from(JSON.stringify(req.body));const expected=crypto.createHmac('sha256',secret).update(raw).digest('hex');const supplied=req.headers['x-marketbridge-signature'];return typeof supplied==='string'&&timingSafeEqual(supplied,expected);}

// Single source of truth for "what happens when a payment is confirmed
// PAID", used by every confirmation path (generic webhook, Chapa webhook,
// Chapa verify-on-return, and manual admin confirm). Previously each path
// duplicated this list of side effects separately, which is exactly how
// the ADVERTISING case got missed from manual confirm earlier — one
// function now, so a new payment type only needs to be handled once.
async function markPaymentPaid(tx,paymentId,{reference,provider,providerTransactionId}={}){
 const payment=await tx.payment.findUnique({where:{id:paymentId},include:{order:true,digitalPurchase:true,advertisement:true}});
 if(!payment)throw Object.assign(new Error('Payment not found'),{status:404});
 if(payment.status==='PAID')return payment;
 if(payment.status==='REFUNDED')throw Object.assign(new Error('Refunded payment cannot be reopened'),{status:409});
 const commission=commissionFor(payment.type,payment.amount);
 const updated=await tx.payment.update({where:{id:payment.id},data:{
  status:'PAID',
  commissionRate:commission.rate,
  commissionAmount:commission.commissionAmount,
  reference:reference||payment.reference,
  provider:provider||payment.provider,
  providerTransactionId:providerTransactionId||payment.providerTransactionId,
 }});
 if(payment.type==='MARKETPLACE'&&payment.orderId)await tx.order.updateMany({where:{id:payment.orderId,status:'PENDING_PAYMENT'},data:{status:'CONFIRMED'}});
 if(payment.type==='DIGITAL'&&payment.digitalPurchase)await tx.digitalPurchase.update({where:{id:payment.digitalPurchase.id},data:{status:'COMPLETED'}});
 if(payment.type==='ADVERTISING'&&payment.advertisement)await tx.advertisement.update({where:{id:payment.advertisement.id},data:{amountPaid:payment.amount}});
 return updated;
}

router.post('/',authenticate,[body('type').isIn(['MARKETPLACE','TRANSPORT','INSPECTOR','ADVERTISING','DIGITAL']),body('amount').isFloat({gt:0}),body('method').isIn(['TELEBIRR','CBE','QR','OTHER']),body('orderId').optional().isUUID(),body('digitalProductId').optional().isUUID(),body('advertisementId').optional().isUUID(),body('inspectionRequestId').optional().isUUID(),body('reference').optional().isString().trim().isLength({max:200})],validate,async(req,res)=>{
 const {type,orderId,digitalProductId,advertisementId,inspectionRequestId,reference}=req.body;const amount=Number(req.body.amount);
 if(type==='MARKETPLACE'||type==='TRANSPORT'){
  if(!orderId)return res.status(400).json({error:`${type} payment requires orderId`});
  const order=await prisma.order.findUnique({where:{id:orderId},include:{transportJob:true}});if(!order)return res.status(404).json({error:'Order not found'});
  if(!isOrderParticipant(req.user.id,order)&&!isAdmin(req.user))return res.status(403).json({error:'Not authorized'});
  if(type==='MARKETPLACE'){if(order.buyerId!==req.user.id&&!isAdmin(req.user))return res.status(403).json({error:'Only the buyer may create the marketplace payment'});if(Math.abs(amount-Number(order.finalPrice))>.01)return res.status(400).json({error:'Amount must match order final price',expectedAmount:Number(order.finalPrice)});}
  if(type==='TRANSPORT'){
   if(!order.transportJob)return res.status(400).json({error:'Transport job required'});
   if(order.transportJob.method==='OWN_TRUCK')return res.status(400).json({error:'Own-truck arrangements are settled directly between the parties; no platform payment applies'});
   if(order.transportJob.agreedAmount==null)return res.status(400).json({error:'This transport job has no accepted quote yet'});
   if(Math.abs(amount-Number(order.transportJob.agreedAmount))>.01)return res.status(400).json({error:'Amount must match the accepted transport quote',expectedAmount:Number(order.transportJob.agreedAmount)});
   const allowed=order.arrangingParty==='BUYER'?order.buyerId:order.arrangingParty==='SELLER'?order.sellerId:order.buyerId===req.user.id||order.sellerId===req.user.id; if(!allowed&&!isAdmin(req.user))return res.status(403).json({error:'Not authorized to pay for this transport'});
  }
 } else if(type==='DIGITAL'){
  if(!digitalProductId)return res.status(400).json({error:'digitalProductId is required'});
  const product=await prisma.digitalProduct.findUnique({where:{id:digitalProductId}});if(!product||product.status!=='ACTIVE')return res.status(404).json({error:'Digital product not found'});if(product.sellerId===req.user.id)return res.status(400).json({error:'You cannot purchase your own product'});if(Math.abs(amount-Number(product.price))>.01)return res.status(400).json({error:'Amount must match product price',expectedAmount:Number(product.price)});
 } else if(type==='ADVERTISING'){
  if(!advertisementId)return res.status(400).json({error:'advertisementId is required'});const ad=await prisma.advertisement.findUnique({where:{id:advertisementId}});if(!ad)return res.status(404).json({error:'Advertisement not found'});if(ad.advertiserId!==req.user.id&&!isAdmin(req.user))return res.status(403).json({error:'Not authorized'});if(ad.amountPaid!=null&&Math.abs(amount-Number(ad.amountPaid))>.01)return res.status(400).json({error:'Amount must match advertisement amount',expectedAmount:Number(ad.amountPaid)});
 } else if(type==='INSPECTOR'){
  if(!inspectionRequestId)return res.status(400).json({error:'inspectionRequestId is required'});
  const request=await prisma.inspectionRequest.findUnique({where:{id:inspectionRequestId}});if(!request)return res.status(404).json({error:'Inspection request not found'});
  if(request.requestedById!==req.user.id&&!isAdmin(req.user))return res.status(403).json({error:'Only the person who requested the inspection may pay for it'});
  if(request.fee==null)return res.status(400).json({error:'This inspection has no agreed fee yet'});
  if(Math.abs(amount-Number(request.fee))>.01)return res.status(400).json({error:'Amount must match the agreed inspection fee',expectedAmount:Number(request.fee)});
 } else if(orderId||digitalProductId||advertisementId||inspectionRequestId){return res.status(400).json({error:'This payment type cannot use the supplied resource id'});}
 const duplicate=await prisma.payment.findFirst({where:{createdById:req.user.id,type,status:{in:['PENDING','PAID']},...(orderId&&{orderId}),...(digitalProductId&&{digitalProductId}),...(advertisementId&&{advertisementId}),...(inspectionRequestId&&{inspectionRequestId})}});if(duplicate)return res.status(409).json({error:'An active payment already exists',payment:duplicate});
 const payment=await prisma.payment.create({data:{createdById:req.user.id,type,amount,method,reference:reference||null,orderId:orderId||null,digitalProductId:digitalProductId||null,advertisementId:advertisementId||null,inspectionRequestId:inspectionRequestId||null,status:'PENDING'}});
 res.status(201).json({message:'Payment intent created. Call /payments/:id/chapa/initialize to get a checkout link, or wait for admin reconciliation.',payment,paymentConfirmed:false});
});

// ============================================================================
// CHAPA CHECKOUT
// ============================================================================
// Works identically against Chapa's test mode (no KYC required) and live
// mode (requires Chapa compliance approval) — only the CHAPA_SECRET_KEY
// env var changes between them.

router.post('/:id/chapa/initialize',authenticate,[param('id').isUUID()],validate,async(req,res)=>{
 const payment=await prisma.payment.findUnique({where:{id:req.params.id}});
 if(!payment)return res.status(404).json({error:'Payment not found'});
 if(payment.createdById!==req.user.id&&!isAdmin(req.user))return res.status(403).json({error:'Not authorized'});
 if(payment.status!=='PENDING')return res.status(409).json({error:`Payment is already ${payment.status}`});

 const appUrl=(process.env.APP_BASE_URL||'').replace(/\/$/,'');
 const apiUrl=(process.env.API_BASE_URL||'').replace(/\/$/,'');
 if(!appUrl||!apiUrl)return res.status(500).json({error:'APP_BASE_URL and API_BASE_URL must be configured to use Chapa checkout'});

 try{
  const {checkoutUrl}=await chapa.initializeTransaction({
   txRef:payment.id,
   amount:payment.amount,
   email:req.user.email,
   firstName:(req.user.name||'MarketBridge').split(' ')[0],
   lastName:(req.user.name||'').split(' ').slice(1).join(' ')||'User',
   phoneNumber:req.user.phone||undefined,
   callbackUrl:`${apiUrl}/api/payments/webhooks/chapa`,
   returnUrl:`${appUrl}/payments/${payment.id}/return`,
   title:payment.type,
   description:`MarketBridge ${payment.type} payment`,
  });
  await prisma.payment.update({where:{id:payment.id},data:{provider:'chapa'}});
  res.json({checkoutUrl});
 }catch(e){
  console.error('CHAPA INITIALIZE ERROR:',e.chapaResponse||e.message);
  res.status(e.status||500).json({error:'Could not start Chapa checkout',details:e.message});
 }
});

// Return-page confirmation: authoritative, synchronous check against Chapa
// directly. Call this from the page the user lands on after Chapa's
// hosted checkout redirects back — don't rely solely on the webhook for
// the return page, since delivery can lag.
router.get('/:id/chapa/verify',authenticate,[param('id').isUUID()],validate,async(req,res)=>{
 const payment=await prisma.payment.findUnique({where:{id:req.params.id}});
 if(!payment)return res.status(404).json({error:'Payment not found'});
 if(payment.createdById!==req.user.id&&!isAdmin(req.user))return res.status(403).json({error:'Not authorized'});
 if(payment.status==='PAID')return res.json({status:'PAID',payment});

 try{
  const {status,raw}=await chapa.verifyTransaction(payment.id);
  if(status==='success'){
   const updated=await prisma.$transaction((tx)=>markPaymentPaid(tx,payment.id,{provider:'chapa',providerTransactionId:raw?.data?.reference||raw?.data?.tx_ref}));
   return res.json({status:'PAID',payment:updated});
  }
  res.json({status:status==='failed'?'FAILED':'PENDING',payment,chapaStatus:status});
 }catch(e){
  console.error('CHAPA VERIFY ERROR:',e.chapaResponse||e.message);
  res.status(e.status||500).json({error:'Could not verify Chapa transaction',details:e.message});
 }
});

// Chapa's async webhook. See the caveat in config/chapa.js — field names
// here are best-effort; confirm against a real test event and adjust if
// needed. tx_ref is assumed to be the Payment id, since that's what we
// send as tx_ref when initializing.
router.post('/webhooks/chapa',express.json({limit:'100kb'}),async(req,res)=>{
 const signature=req.headers['chapa-signature']||req.headers['x-chapa-signature'];
 const rawBody=JSON.stringify(req.body);
 if(!chapa.verifyWebhookSignature(rawBody,signature)){
  console.error('CHAPA WEBHOOK: invalid signature, payload was:',rawBody);
  return res.status(401).json({error:'Invalid webhook signature'});
 }
 const txRef=req.body?.tx_ref||req.body?.reference;
 const eventStatus=req.body?.status;
 if(!txRef)return res.status(400).json({error:'Invalid webhook payload — no tx_ref'});
 try{
  if(eventStatus==='success'||eventStatus==='successful'){
   const updated=await prisma.$transaction((tx)=>markPaymentPaid(tx,txRef,{provider:'chapa',providerTransactionId:req.body?.reference}));
   return res.json({ok:true,payment:updated});
  }
  res.json({ok:true,ignored:true,eventStatus});
 }catch(e){res.status(e.status||500).json({error:e.status?e.message:'Chapa webhook processing failed'});}
});

// Gateway callback. Configure PAYMENT_WEBHOOK_SECRET and have the gateway send HMAC-SHA256.
// The gateway-specific adapter should translate provider events into {paymentId,status,reference,provider,providerTransactionId}.
router.post('/webhooks/generic',express.json({limit:'100kb'}),async(req,res)=>{
 if(!verifySignature(req))return res.status(401).json({error:'Invalid webhook signature'});
 const {paymentId,status,reference,provider,providerTransactionId}=req.body;
 if(!paymentId||!['PAID','FAILED','REFUNDED'].includes(status))return res.status(400).json({error:'Invalid webhook payload'});
 try{
  if(status==='PAID'){
   const updated=await prisma.$transaction((tx)=>markPaymentPaid(tx,paymentId,{reference,provider,providerTransactionId}));
   return res.json({ok:true,payment:updated});
  }
  const result=await prisma.$transaction(async(tx)=>{
   const payment=await tx.payment.findUnique({where:{id:paymentId},include:{digitalPurchase:true}});if(!payment)throw Object.assign(new Error('Payment not found'),{status:404});
   if(payment.status==='REFUNDED'&&status!=='REFUNDED')throw Object.assign(new Error('Refunded payment cannot be reopened'),{status:409});
   const updated=await tx.payment.update({where:{id:payment.id},data:{status,reference:reference||payment.reference,provider:provider||payment.provider,providerTransactionId:providerTransactionId||payment.providerTransactionId}});
   if(status==='REFUNDED'&&payment.digitalPurchase)await tx.digitalPurchase.update({where:{id:payment.digitalPurchase.id},data:{status:'REFUNDED'}});
   return updated;
  });
  res.json({ok:true,payment:result});
 }catch(e){res.status(e.status||500).json({error:e.status?e.message:'Webhook processing failed'});}
});

// Admin queue: list payments, optionally filtered by status, for manual reconciliation.
router.get('/',authenticate,async(req,res)=>{
 if(!isAdmin(req.user))return res.status(403).json({error:'Only an administrator can view all payments'});
 const {status}=req.query;
 const payments=await prisma.payment.findMany({
  where:{...(status&&{status})},
  include:{
   createdBy:{select:{id:true,name:true,email:true}},
   order:{select:{id:true,finalPrice:true}},
   digitalProduct:{select:{id:true,title:true}},
   advertisement:{select:{id:true,type:true}},
   inspectionRequest:{select:{id:true,fee:true}},
  },
  orderBy:{createdAt:'desc'},
 });
 res.json({payments,count:payments.length});
});

// Commission summary for admin revenue reporting: totals collected, by type,
// across confirmed (PAID) payments only.
router.get('/commissions/summary',authenticate,async(req,res)=>{
 if(!isAdmin(req.user))return res.status(403).json({error:'Only an administrator can view commission records'});
 const paid=await prisma.payment.findMany({where:{status:'PAID'},select:{type:true,amount:true,commissionAmount:true}});
 const byType={};
 let totalCommission=0,totalVolume=0;
 for(const p of paid){
  const t=byType[p.type]||{volume:0,commission:0,count:0};
  t.volume+=Number(p.amount);
  t.commission+=Number(p.commissionAmount||0);
  t.count+=1;
  byType[p.type]=t;
  totalVolume+=Number(p.amount);
  totalCommission+=Number(p.commissionAmount||0);
 }
 res.json({totalVolume,totalCommission,byType});
});

// Legacy manual confirmation — for payments with NO gateway attached at
// all (method recorded but no online processor involved, e.g. an
// off-platform cash/bank-transfer arrangement an admin is reconciling by
// hand). Once a payment has been handed to a real gateway (provider is
// set, e.g. 'chapa'), this route refuses to touch it: an admin trust-click
// must never be able to mark a gateway-linked payment PAID without the
// gateway itself confirming the money actually moved. Use
// GET /:id/chapa/verify (or the equivalent for whichever gateway is
// attached) to check and confirm those instead.
router.patch('/:id/confirm',authenticate,async(req,res)=>{
 if(!isAdmin(req.user))return res.status(403).json({error:'Only an administrator can perform manual payment reconciliation'});
 const existing=await prisma.payment.findUnique({where:{id:req.params.id}});
 if(!existing)return res.status(404).json({error:'Payment not found'});
 if(existing.status!=='PENDING')return res.status(409).json({error:`Payment is already ${existing.status}`});
 if(existing.provider)return res.status(409).json({error:`This payment is linked to ${existing.provider} — confirm it through that gateway's verification, not manually`});
 const updated=await prisma.$transaction((tx)=>markPaymentPaid(tx,req.params.id));
 res.json({message:'Payment manually reconciled.',payment:updated});
});

router.get('/order/:orderId',authenticate,[param('orderId').isUUID()],validate,async(req,res)=>{const order=await prisma.order.findUnique({where:{id:req.params.orderId}});if(!order)return res.status(404).json({error:'Order not found'});if(!isOrderParticipant(req.user.id,order)&&!isAdmin(req.user))return res.status(403).json({error:'Not authorized'});const payments=await prisma.payment.findMany({where:{orderId:order.id},orderBy:{createdAt:'desc'}});res.json({payments,count:payments.length});});
router.get('/:id',authenticate,[param('id').isUUID()],validate,async(req,res)=>{const payment=await prisma.payment.findUnique({where:{id:req.params.id},include:{order:true,digitalPurchase:true}});if(!payment)return res.status(404).json({error:'Payment not found'});const owner=payment.createdById===req.user.id;const orderParticipant=payment.order&&isOrderParticipant(req.user.id,payment.order);if(!owner&&!orderParticipant&&!isAdmin(req.user))return res.status(403).json({error:'Not authorized'});res.json({payment});});
module.exports=router;
