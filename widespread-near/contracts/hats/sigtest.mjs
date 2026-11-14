import { Account, KeyPair, KeyPairSigner } from 'near-api-js';
import { readFileSync } from 'fs'; import os from 'os'; import path from 'path';
const c = JSON.parse(readFileSync(path.join(os.homedir(), '.intentional-hats.json')));
const account = new Account(c.accountId, 'https://rpc.testnet.near.org', new KeyPairSigner(KeyPair.fromString(c.secretKey)));
try {
  const r = await account.callFunction({contractId:c.accountId,methodName:'requestForeignSig',args:{hatId:'6',payload:[1,2,3,4,5],path:'solana-1',keyType:'ed25519'},gas:80000000000000n,deposit:0n});
  console.log('RESULT', JSON.stringify(r));
} catch(e) { console.log('ERR', e.message.slice(0,400)); }
