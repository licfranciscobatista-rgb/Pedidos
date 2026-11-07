import test from 'node:test';
import assert from 'node:assert/strict';
import {storeProfiles,defaultStoreId} from '../public/caja/profiles.mjs';

test('IndexedDB and demo cache are isolated by store while old Librería data migrates',async()=>{
  await import('fake-indexeddb/auto');
  const storage=await import('../public/caja/storage.mjs');
  const deviceId='shared-test-device';

  for(const [index,profile] of storeProfiles.entries()){
    storage.selectStorage(`primary:${profile.id}`);
    await storage.initializePrimary('qa-owner',deviceId,profile.name);
    await storage.localOperation({id:`import-${index}`,at:new Date().toISOString(),kind:'import',data:{products:[{
      id:`product-${index}`,sku:`TEST-${index}`,name:`Artículo ${profile.name}`,unitCents:10000,costCents:5000,stock:5000,minStock:1000,category:profile.name,active:true,
    }]}});
    const local=await storage.readLocal();
    assert.equal(local.state.products.length,1);
    assert.equal(local.state.products[0].name,`Artículo ${profile.name}`);
  }

  storage.selectStorage(`primary:${storeProfiles[0].id}`);
  assert.deepEqual((await storage.readLocal()).state.products.map(p=>p.name),['Artículo Librería Valencia']);
  storage.selectStorage(`demo:${storeProfiles[0].id}`);
  assert.equal(await storage.readLocal(),null);

  const db=await storage.openStore();
  const legacy={ownerId:'qa-owner',deviceId,state:{schema:1,version:1,shop:{name:'Librería Valencia'},products:[],sales:[],movements:[],operations:['old']},uploadedVersion:1,lastSync:null,backupAt:null};
  await new Promise((resolve,reject)=>{const tx=db.transaction('records','readwrite'),records=tx.objectStore('records');records.delete(`primary:${defaultStoreId}`);records.put(legacy,'primary');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
  storage.selectStorage(`primary:${defaultStoreId}`);
  assert.deepEqual(await storage.readLocal(),legacy);
});
