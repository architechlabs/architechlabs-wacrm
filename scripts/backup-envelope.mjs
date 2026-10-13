import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAGIC = Buffer.from('ALDBKP01');
const PROJECT = 'nthvtmzvmjiowvjgitmv';
const FILES = new Set(['roles.sql','schema.sql','data.sql','managed-schema.sql','managed-data.sql']);
const MAX_BYTES = 256*1024*1024;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function aad(name) {
  if (!FILES.has(name)) throw new Error('Invalid backup filename');
  return Buffer.from(JSON.stringify({version:1,projectRef:PROJECT,filename:name}));
}
export function sealBackup(bytes,key,name) {
  if (key.length !== 32 || bytes.length > MAX_BYTES) throw new Error('Invalid backup input');
  const nonce=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(aad(name));
  const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);
  return Buffer.concat([MAGIC,nonce,cipher.getAuthTag(),ciphertext]);
}
export function openBackup(bytes,key,name) {
  if (key.length !== 32 || bytes.length < 36 || bytes.length > MAX_BYTES+36 || !bytes.subarray(0,8).equals(MAGIC)) throw new Error('Invalid backup envelope');
  const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(8,20));
  cipher.setAAD(aad(name));cipher.setAuthTag(bytes.subarray(20,36));
  return Buffer.concat([cipher.update(bytes.subarray(36)),cipher.final()]);
}
function keyFromFile(path) {
  const record=JSON.parse(readFileSync(path,'utf8'));
  if (record.projectRef !== PROJECT || record.algorithm !== 'AES-256-GCM' || !/^[0-9a-f]{64}$/.test(record.keyHex)) throw new Error('Invalid recovery key');
  return Buffer.from(record.keyHex,'hex');
}
function main(args) {
  const [command,...paths]=args;
  if (command === 'init-key' && paths.length === 1) {
    writeFileSync(paths[0],JSON.stringify({version:1,projectRef:PROJECT,algorithm:'AES-256-GCM',keyHex:randomBytes(32).toString('hex')})+'\n',{flag:'wx',mode:0o600});
    process.stdout.write('Recovery key created separately; its value is not displayed.\n');
    return;
  }
  if (command === 'seal' && paths.length === 3) {
    const [input,output,keyPath]=paths;
    const name=basename(input),key=keyFromFile(keyPath),plain=readFileSync(input);
    try {
      const encrypted=sealBackup(plain,key,name);
      writeFileSync(output,encrypted,{flag:'wx',mode:0o600});
      const recovered=openBackup(readFileSync(output),key,name);
      try { if (digest(recovered) !== digest(plain)) throw new Error('Backup round-trip failed'); }
      finally { recovered.fill(0); }
      process.stdout.write(JSON.stringify({name:name+'.enc',plaintextBytes:plain.length,plaintextSha256:digest(plain),encryptedSha256:digest(encrypted)})+'\n');
    } finally { key.fill(0);plain.fill(0); }
    return;
  }
  if (command === 'verify' && paths.length === 3) {
    const [directory,keyPath,manifestPath]=paths;
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    if (manifest.projectRef !== PROJECT || manifest.encryption !== 'AES-256-GCM' || manifest.files?.length !== FILES.size) throw new Error('Invalid manifest');
    const key=keyFromFile(keyPath),seen=new Set();
    try {
      for (const file of manifest.files) {
        const name=file.name?.slice(0,-4);
        if (!FILES.has(name) || file.name !== name+'.enc' || seen.has(name)) throw new Error('Invalid file inventory');
        seen.add(name);
        const encrypted=readFileSync(resolve(directory,file.name));
        if (digest(encrypted) !== file.encryptedSha256) throw new Error('Encrypted hash mismatch');
        const plain=openBackup(encrypted,key,name);
        try { if (plain.length !== file.plaintextBytes || digest(plain) !== file.plaintextSha256) throw new Error('Plaintext hash mismatch'); }
        finally { plain.fill(0); }
      }
    } finally { key.fill(0); }
    process.stdout.write('Portable backup decryption and all checksums verified; restore testing and off-device/key recovery remain separate.\n');
    return;
  }
  throw new Error('Invalid backup command');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch { process.stderr.write('Backup encryption/verification failed; sensitive details omitted.\n');process.exitCode=1; }
}
