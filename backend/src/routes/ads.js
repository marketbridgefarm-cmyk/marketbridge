const express = require('express');
const { body, param, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { isAdmin } = require('../utils/authorization');
const router = express.Router();
const validate = (req,res,next)=>{const e=validationResult(req); if(!e.isEmpty()) return res.status(400).json({error:'Validation failed',errors:e.array()}); next();};

router.post('/', authenticate, requireRole('ADVERTISER'), [
  body('type').isIn(['FEATURED_LISTING','TOP_OF_CATEGORY','SPONSORED_SEARCH','BANNER','TELEGRAM_PROMOTION']),
  body('listingId').optional({values:'falsy'}).isUUID(),
  body('startDate').isISO8601(), body('endDate').isISO8601(),
  body('amountPaid').optional({values:'falsy'}).isFloat({min:0}),
], validate, async (req,res)=>{
  const startDate=new Date(req.body.startDate), endDate=new Date(req.body.endDate);
  if (endDate <= startDate) return res.status(400).json({error:'endDate must be after startDate'});
  if (req.body.listingId) {
    const listing=await prisma.listing.findUnique({where:{id:req.body.listingId},select:{sellerId:true}});
    if(!listing) return res.status(404).json({error:'Listing not found'});
    if(listing.sellerId!==req.user.id && !isAdmin(req.user)) return res.status(403).json({error:'You may only advertise your own listing'});
  }
  const ad=await prisma.advertisement.create({data:{advertiserId:req.user.id,type:req.body.type,listingId:req.body.listingId||null,startDate,endDate,amountPaid:req.body.amountPaid==null?null:Number(req.body.amountPaid),status:'PENDING'}});
  res.status(201).json({ad});
});

router.get('/active', async (req,res)=>{
  const now=new Date();
  const ads=await prisma.advertisement.findMany({where:{status:'ACTIVE',startDate:{lte:now},endDate:{gte:now}},include:{listing:true},orderBy:{startDate:'asc'}});
  res.json({ads});
});

router.patch('/:id/status', authenticate, requireRole('ADMIN'), [param('id').isUUID(),body('status').isIn(['ACTIVE','REJECTED','EXPIRED'])], validate, async(req,res)=>{
  const ad=await prisma.advertisement.findUnique({where:{id:req.params.id}});
  if(!ad)return res.status(404).json({error:'Advertisement not found'});
  if(req.body.status==='ACTIVE' && ad.endDate<=new Date()) return res.status(400).json({error:'Cannot activate an expired advertisement'});
  const updated=await prisma.advertisement.update({where:{id:ad.id},data:{status:req.body.status}});
  res.json({ad:updated});
});
module.exports=router;
