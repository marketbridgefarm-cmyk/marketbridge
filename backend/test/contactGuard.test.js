const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AMOUNT_LIMITS,
  findContactInfo,
  noContactInfo,
  amountProblem,
  validAmount,
} = require('../src/utils/contactGuard');

test('clean deal text is allowed', () => {
  for (const text of [
    'Hi, 450 ETB is fair for this lot',
    'Price 1,250,000 ETB final',
    'Deliver 20.5 tons by Monday',
    'Please bring 100kg',
    '',
    null,
  ]) {
    assert.equal(findContactInfo(text), null, String(text));
  }
});

test('phone numbers are detected in common and evasive formats', () => {
  for (const text of [
    '0911223344',
    '+251 911 22 33 44',
    '+251-911-223344',
    '(0911) 223 344',
    'nine one one two two three three four four',
    '\u0660\u0669\u0661\u0661\u0662\u0662\u0663\u0663\u0664\u0664', // Arabic-Indic digits
    '\uFF10\uFF19\uFF11\uFF11\uFF12\uFF12\uFF13\uFF13\uFF14\uFF14', // full-width digits
  ]) {
    assert.equal(findContactInfo(text), 'phone', text);
  }
});

test('emails, links, handles, chat apps and contact phrases are detected', () => {
  assert.equal(findContactInfo('abebe@gmail.com'), 'email');
  assert.equal(findContactInfo('abebe (at) gmail (dot) com'), 'email');
  assert.equal(findContactInfo('join t.me/abebe'), 'link');
  assert.equal(findContactInfo('see www.example.com'), 'link');
  assert.equal(findContactInfo('add @abebe_k'), 'handle');
  assert.equal(findContactInfo('find me on telegram'), 'app');
  assert.equal(findContactInfo('call me tonight'), 'phrase');
  assert.equal(findContactInfo('\u1235\u120D\u12AD'), 'phrase'); // Amharic "phone"
});

test('noContactInfo validator throws a user-facing message', () => {
  assert.equal(noContactInfo('fair price'), true);
  assert.throws(() => noContactInfo('0911223344'), /keep contact details off MarketBridge/);
});

test('amounts: range, positivity and decimals are enforced', () => {
  const max = AMOUNT_LIMITS.offer;
  assert.equal(amountProblem(450, max), null);
  assert.equal(amountProblem('450.25', max), null);
  assert.match(amountProblem(0, max), /greater than zero/);
  assert.match(amountProblem('abc', max), /greater than zero/);
  assert.match(amountProblem(10.123, max), /2 decimal/);
  assert.match(amountProblem(max + 1, max), /cannot be more than/);
  assert.match(amountProblem(undefined, max), /required/);
});

test('a phone number can never pass as a price', () => {
  for (const value of ['0911223344', 911223344, 251911223344, '0711223344']) {
    for (const limit of Object.values(AMOUNT_LIMITS)) {
      assert.ok(amountProblem(value, limit), `${value} @ ${limit}`);
    }
  }
});

test('validAmount builds a throwing validator', () => {
  const check = validAmount(AMOUNT_LIMITS.inspection);
  assert.equal(check(500), true);
  assert.throws(() => check(2000000), /cannot be more than/);
});
