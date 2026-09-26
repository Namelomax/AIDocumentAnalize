import bcrypt from 'bcryptjs';

// Cost 10 keeps a login around a tenth of a second: slow enough to make
// guessing expensive, fast enough not to eat into the 200 ms p95 budget of
// section 11 for the rest of the API.
const COST = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
