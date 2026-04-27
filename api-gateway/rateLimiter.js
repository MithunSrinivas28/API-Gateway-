const buckets = new Map();

const BUCKET_CAPACITY = 10;      // max tokens per IP
const REFILL_RATE = 2;           // tokens added per second

function getBucket(ip) {
  if (!buckets.has(ip)) {
    buckets.set(ip, {
      tokens: BUCKET_CAPACITY,
      lastRefill: Date.now()
    });
  }
  return buckets.get(ip);
}

function refillBucket(bucket) {
  const now = Date.now();
  const secondsElapsed = (now - bucket.lastRefill) / 1000;
  const tokensToAdd = secondsElapsed * REFILL_RATE;

  bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + tokensToAdd);
  bucket.lastRefill = now;
}

function isAllowed(ip) {
  const bucket = getBucket(ip);
  refillBucket(bucket);

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

module.exports = { isAllowed };