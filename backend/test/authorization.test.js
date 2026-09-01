const test=require('node:test');
const assert=require('node:assert/strict');
const {isOrderParticipant,isConversationParticipant}=require('../src/utils/authorization');
const order={buyerId:'buyer',sellerId:'seller',transportJob:{truckOwnerId:'truck'}};
test('order participants are buyer and seller',()=>{assert.equal(isOrderParticipant('buyer',order),true);assert.equal(isOrderParticipant('seller',order),true);assert.equal(isOrderParticipant('truck',order),false);});
test('conversation participants include truck owner',()=>{assert.equal(isConversationParticipant('truck',order),true);assert.equal(isConversationParticipant('random',order),false);});
