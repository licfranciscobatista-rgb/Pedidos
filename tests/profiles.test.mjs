import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultStoreId,inventoryNamespace,storeProfiles} from '../public/caja/profiles.mjs';

test('publica los tres perfiles de Valencia',()=>{
  assert.deepEqual(storeProfiles.map(profile=>profile.name),[
    'Librería Valencia','Electrónica Valencia','Decoraciones Valencia',
  ]);
});

test('mantiene librería en su clave anterior y separa los demás perfiles',()=>{
  const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.equal(inventoryNamespace(owner,defaultStoreId),owner);
  const keys=storeProfiles.map(profile=>inventoryNamespace(owner,profile.id));
  assert.equal(new Set(keys).size,3);
  assert.equal(keys[1],`${owner}:${storeProfiles[1].id}`);
  assert.equal(keys[2],`${owner}:${storeProfiles[2].id}`);
  assert.equal(inventoryNamespace(owner,'not-a-store'),null);
});
