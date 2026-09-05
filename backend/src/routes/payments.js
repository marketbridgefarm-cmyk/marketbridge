const express=require('express');
const crypto=require('crypto');
const {body,param,validationResult}=require('express-validator');
const prisma=require('../config/db');
const {authenticate}=require('../middleware/auth');
const {isAdmin,isOrderParticipant}=require('../utils/authorization');
const {commissionFor}=require('../config/commissions');
const router=express.Router();
const validate=(req,res,next)=>{const e=validationResult(req);if(!e.isEmpty())return res.status(400).json({error:'Validation failed',errors:e.array()});next();};
function timingSafeEqual(a,b){const x=Buffer.from(a||'','utf8'),y=Buffer.from(b||'','utf8');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function verifySignature(req){const secret=process.env.PAYMENT_WEBHOOK_SECRET;if(!secret)return false;const raw=req.rawBody || Buffer.from(JSON.stringify(req.body));const expected=crypto.createHmac('sha256',secret).update(raw).digest('hex');const supplied=req.headers['x-marketbridge-signature'];return typeof supplied==='string'&&timingSafeEqual(supplied,expected);}

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
 res.status(201).json({message:'Payment intent created; it is not paid until verified by a gateway webhook.',payment,paymentConfirmed:false});
});

// Gateway callback. Configure PAYMENT_WEBHOOK_SECRET and have the gateway send HMAC-SHA256.
// The gateway-specific adapter should translate provider events into {paymentId,status,reference,provider,providerTransactionId}.
router.post('/webhooks/generic',express.json({limit:'100kb'}),async(req,res)=>{
 if(!verifySignature(req))return res.status(401).json({error:'Invalid webhook signature'});
 const {paymentId,status,reference,provider,providerTransactionId}=req.body;
 if(!paymentId||!['PAID','FAILED','REFUNDED'].includes(status))return res.status(400).json({error:'Invalid webhook payload'});
 try{
  const result=await prisma.$transaction(async(tx)=>{
   const payment=await tx.payment.findUnique({where:{id:paymentId},include:{order:true,digitalPurchase:true,advertisement:true}});if(!payment)throw Object.assign(new Error('Payment not found'),{status:404});
   if(payment.status==='PAID'&&status==='PAID')return payment;
   if(payment.status==='REFUNDED'&&status!=='REFUNDED')throw Object.assign(new Error('Refunded payment cannot be reopened'),{status:409});
   const commission=status==='PAID'?commissionFor(payment.type,payment.amount):{rate:payment.commissionRate,commissionAmount:payment.commissionAmount};
   const updated=await tx.payment.update({where:{id:payment.id},data:{status,reference:reference||payment.reference,provider:provider||payment.provider,providerTransactionId:providerTransactionId||payment.providerTransactionId,...(status==='PAID'&&{commissionRate:commission.rate,commissionAmount:commission.commissionAmount})}});
   if(status==='PAID'){
    if(payment.type==='MARKETPLACE'&&payment.orderId)await tx.order.updateMany({where:{id:payment.orderId,status:'PENDING_PAYMENT'},data:{status:'CONFIRMED'}});
    if(payment.type==='DIGITAL'&&payment.digitalPurchase)await tx.digitalPurchase.update({where:{id:payment.digitalPurchase.id},data:{status:'COMPLETED'}});
    if(payment.type==='ADVERTISING'&&payment.advertisement)await tx.advertisement.update({where:{id:payment.advertisement.id},data:{amountPaid:payment.amount}});
   }
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

// Legacy manual confirmation. Kept only for controlled admin reconciliation; production gateways should use webhooks.
router.patch('/:id/confirm',authenticate,async(req,res)=>{
 if(!isAdmin(req.user))return res.status(403).json({error:'Only an administrator can perform manual payment reconciliation'});
 const payment=await prisma.payment.findUnique({where:{id:req.params.id}});if(!payment)return res.status(404).json({error:'Payment not found'});if(payment.status!=='PENDING')return res.status(409).json({error:`Payment is already ${payment.status}`});
 const commission=commissionFor(payment.type,payment.amount);
 const updated=await prisma.$transaction(async(tx)=>{
  const p=await tx.payment.update({where:{id:payment.id},data:{status:'PAID',commissionRate:commission.rate,commissionAmount:commission.commissionAmount}});
  if(payment.type==='MARKETPLACE'&&payment.orderId)await tx.order.updateMany({where:{id:payment.orderId,status:'PENDING_PAYMENT'},data:{status:'CONFIRMED'}});
  if(payment.type==='DIGITAL'){const purchase=await tx.digitalPurchase.findUnique({where:{paymentId:payment.id}});if(purchase)await tx.digitalPurchase.update({where:{id:purchase.id},data:{status:'COMPLETED'}});}
  if(payment.type==='ADVERTISING'&&payment.advertisementId)await tx.advertisement.update({where:{id:payment.advertisementId},data:{amountPaid:payment.amount}});
  return p;
 });
 res.json({message:'Payment manually reconciled. Prefer signed provider webhooks in production.',payment:updated});
});

router.get('/order/:orderId',authenticate,[param('orderId').isUUID()],validate,async(req,res)=>{const order=await prisma.order.findUnique({where:{id:req.params.orderId}});if(!order)return res.status(404).json({error:'Order not found'});if(!isOrderParticipant(req.user.id,order)&&!isAdmin(req.user))return res.status(403).json({error:'Not authorized'});const payments=await prisma.payment.findMany({where:{orderId:order.id},orderBy:{createdAt:'desc'}});res.json({payments,count:payments.length});});
router.get('/:id',authenticate,[param('id').isUUID()],validate,async(req,res)=>{const payment=await prisma.payment.findUnique({where:{id:req.params.id},include:{order:true,digitalPurchase:true}});if(!payment)return res.status(404).json({error:'Payment not found'});const owner=payment.createdById===req.user.id;const orderParticipant=payment.order&&isOrderParticipant(req.user.id,payment.order);if(!owner&&!orderParticipant&&!isAdmin(req.user))return res.status(403).json({error:'Not authorized'});res.json({payment});});
module.exports=router;
