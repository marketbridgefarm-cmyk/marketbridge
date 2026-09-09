const test = require('node:test');
const assert = require('node:assert/strict');

const {
  authenticate,
  getBearerToken,
} = require('../src/middleware/auth');

const listingsRouter =
  require('../src/routes/listings');

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
  };

  res.status = (code) => {
    res.statusCode = code;
    return res;
  };

  res.json = (payload) => {
    res.body = payload;
    return res;
  };

  return res;
}

// ============================================================================
// AUTHENTICATION
// ============================================================================

test(
  'getBearerToken extracts a token from a well-formed header',
  () => {
    assert.equal(
      getBearerToken({
        headers: {
          authorization:
            'Bearer abc123',
        },
      }),
      'abc123'
    );
  }
);

test(
  'getBearerToken returns null when the header is missing or malformed',
  () => {
    assert.equal(
      getBearerToken({
        headers: {},
      }),
      null
    );

    assert.equal(
      getBearerToken({
        headers: {
          authorization:
            'abc123',
        },
      }),
      null
    );

    assert.equal(
      getBearerToken({
        headers: {
          authorization:
            'Bearer ',
        },
      }),
      null
    );
  }
);

test(
  'authenticate rejects requests with no Authorization header (401)',
  async () => {
    const req = {
      headers: {},
    };

    const res = mockRes();

    let nextCalled = false;

    await authenticate(
      req,
      res,
      () => {
        nextCalled = true;
      }
    );

    assert.equal(
      res.statusCode,
      401
    );

    assert.equal(
      nextCalled,
      false
    );
  }
);

test(
  'authenticate refuses to run if JWT_SECRET is missing or too short (500, fails closed)',
  async () => {
    const original =
      process.env.JWT_SECRET;

    process.env.JWT_SECRET =
      'too-short';

    const req = {
      headers: {
        authorization:
          'Bearer sometoken',
      },
    };

    const res = mockRes();

    let nextCalled = false;

    try {
      await authenticate(
        req,
        res,
        () => {
          nextCalled = true;
        }
      );

      assert.equal(
        res.statusCode,
        500
      );

      assert.equal(
        nextCalled,
        false
      );
    } finally {
      if (
        original ===
        undefined
      ) {
        delete process.env.JWT_SECRET;
      } else {
        process.env.JWT_SECRET =
          original;
      }
    }
  }
);

test(
  'authenticate rejects an invalid/garbage token (401, not a 500 or crash)',
  async () => {
    const original =
      process.env.JWT_SECRET;

    process.env.JWT_SECRET =
      'a'.repeat(32);

    const req = {
      headers: {
        authorization:
          'Bearer not-a-real-jwt',
      },
    };

    const res = mockRes();

    let nextCalled = false;

    try {
      await authenticate(
        req,
        res,
        () => {
          nextCalled = true;
        }
      );

      assert.equal(
        res.statusCode,
        401
      );

      assert.equal(
        nextCalled,
        false
      );
    } finally {
      if (
        original ===
        undefined
      ) {
        delete process.env.JWT_SECRET;
      } else {
        process.env.JWT_SECRET =
          original;
      }
    }
  }
);

// ============================================================================
// LISTING DATA-EXPOSURE REGRESSION
// ============================================================================

test(
  'public listing serializer never exposes minAcceptablePrice',
  () => {
    const listing = {
      id: 'listing-1',
      sellerId: 'seller-1',
      category: 'AGRICULTURAL',
      title: 'Maize',
      cropType: 'Maize',
      quantity: 100,
      unit: 'kg',
      askingPrice: 50000,

      // PRIVATE SELLER FIELD
      minAcceptablePrice: 42000,

      location: 'Addis Ababa',
      description: 'Test listing',

      seller: {
        id: 'seller-1',
        name: 'Farmer',
      },
    };

    const publicListing =
      listingsRouter.toPublicListing(
        listing
      );

    assert.equal(
      publicListing.id,
      'listing-1'
    );

    assert.equal(
      publicListing.askingPrice,
      50000
    );

    assert.equal(
      Object.prototype.hasOwnProperty.call(
        publicListing,
        'minAcceptablePrice'
      ),
      false
    );

    assert.equal(
      publicListing.minAcceptablePrice,
      undefined
    );
  }
);

test(
  'public listing serializer keeps safe seller information',
  () => {
    const listing = {
      id: 'listing-2',
      sellerId: 'seller-2',
      title: 'Wheat',
      askingPrice: 1000,

      minAcceptablePrice: 800,

      seller: {
        id: 'seller-2',
        name: 'Seller',
        rating: 4.5,
      },
    };

    const publicListing =
      listingsRouter.toPublicListing(
        listing
      );

    assert.deepEqual(
      publicListing.seller,
      {
        id: 'seller-2',
        name: 'Seller',
        rating: 4.5,
      }
    );

    assert.equal(
      'minAcceptablePrice' in
        publicListing,
      false
    );
  }
);
