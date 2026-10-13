import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { digest, openBackup, sealBackup } from './backup-envelope.mjs';

test('portable backup encrypts exact bytes with randomized authenticated envelopes',() => {
  const key=randomBytes(32),plain=Buffer.from('Synthetic backup only; no production data.');
  const first=sealBackup(plain,key,'schema.sql'),second=sealBackup(plain,key,'schema.sql');
  assert.notDeepEqual(first,second);assert.ok(!first.includes(plain));
  assert.deepEqual(openBackup(first,key,'schema.sql'),plain);
  assert.equal(digest(openBackup(second,key,'schema.sql')),digest(plain));
});
test('tampering, wrong recovery keys and file substitution fail closed',() => {
  const key=randomBytes(32),sealed=sealBackup(Buffer.from('fixture'),key,'data.sql');
  for (const offset of [0,8,20,35,36,sealed.length-1]) {
    const changed=Buffer.from(sealed);changed[offset]^=1;
    assert.throws(() => openBackup(changed,key,'data.sql'));
  }
  assert.throws(() => openBackup(sealed,randomBytes(32),'data.sql'));
  assert.throws(() => openBackup(sealed,key,'roles.sql'));
  assert.throws(() => openBackup(sealed,key,'../data.sql'));
  assert.throws(() => openBackup(Buffer.alloc(10),key,'data.sql'));
  assert.throws(() => sealBackup(Buffer.from('fixture'),Buffer.alloc(16),'data.sql'));
});
