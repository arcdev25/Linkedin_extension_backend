// Generate a bcrypt hash and the SQL to apply it.
// Runs locally; nothing is sent anywhere.
//
//   node tools/hash-password.mjs 'new-password' 'user@example.com'
//
// Use this to unblock an account whose password nobody remembers. For ongoing
// use, prefer the endpoints: /auth/change-password (self) or
// PATCH /api/owners/:id/password (admin).
import bcrypt from 'bcryptjs';


const [password, email] = process.argv.slice(2);

if (!password) {
  console.error("Usage: node tools/hash-password.mjs '<password>' ['<email>']");
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters (the API enforces this too).');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 10);

console.log('\nhash:', hash);
console.log('\nSQL:\n');

if (email) {
  console.log(`UPDATE owners SET password = '${hash}'`);
  console.log(`WHERE email = '${email}';`);
  console.log(`\n-- Then force a fresh login on any device already signed in:`);
  console.log(`DELETE FROM auth_sessions WHERE owner_id =`);
  console.log(`  (SELECT id FROM owners WHERE email = '${email}');`);
} else {
  console.log(`UPDATE owners SET password = '${hash}' WHERE email = 'REPLACE_ME';`);
}
console.log('');
