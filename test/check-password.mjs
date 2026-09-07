// Verify a password against a bcrypt hash straight from your owners table.
// Runs entirely locally — nothing is sent anywhere.
//
//   node test/check-password.mjs '<hash from the DB>' '<password to try>'
//
// Get the hash with:
//   SELECT email, password FROM owners WHERE email = 'Rape@owner.com';
import bcrypt from 'bcryptjs';

const [hash, password] = process.argv.slice(2);

if (!hash || !password) {
  console.error("Usage: node test/check-password.mjs '<hash>' '<password>'");
  process.exit(1);
}

console.log('hash prefix :', hash.slice(0, 4), '(expect $2a$, $2b$ or $2y$)');
console.log('hash length :', hash.length, '(expect 60)');

if (hash.length !== 60) {
  console.log('\n⚠️  That is not a full bcrypt hash. If the column is too narrow');
  console.log('   (e.g. VARCHAR(50)) Postgres truncated it on insert, and no');
  console.log('   password can ever match. Check with:');
  console.log("   SELECT character_maximum_length FROM information_schema.columns");
  console.log("   WHERE table_name='owners' AND column_name='password';");
}

console.log('\nmatch       :', await bcrypt.compare(password, hash) ? 'YES ✓' : 'NO ✗');
