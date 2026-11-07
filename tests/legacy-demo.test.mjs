import test from 'node:test';
import assert from 'node:assert/strict';
import {applyOperation,initialState} from '../public/caja/domain.mjs';
import {createDemoCatalog,createDemoSales,demoFixtureNeedsShopName,isLegacyDemo} from '../public/caja/demo-fixtures.mjs';
import {storeProfiles} from '../public/caja/profiles.mjs';

const legacyProducts=[
  {id:'rice',sku:'ARR-001',name:'Arroz selecto · libra',category:'Alimentos',unitCents:4500,costCents:3300,stock:85000,minStock:10000,active:true,barcode:''},
  {id:'oil',sku:'ACE-001',name:'Aceite vegetal · 1 litro',category:'Alimentos',unitCents:18500,costCents:14500,stock:18000,minStock:5000,active:true,barcode:''},
  {id:'soap',sku:'JAB-001',name:'Jabón de baño · 100 g',category:'Cuidado personal',unitCents:6500,costCents:4200,stock:4000,minStock:5000,active:true,barcode:''},
];

test('identifies the untouched three-item demo created by the prior release',()=>{
  const state=applyOperation(initialState(),{id:'legacy-seed',kind:'import',at:'2026-01-01T00:00:00.000Z',data:{products:legacyProducts}});
  assert.equal(state.operations.length,4);
  assert.equal(isLegacyDemo(state),true);
});

test('does not reset a demo after it has been edited',()=>{
  const seeded=applyOperation(initialState(),{id:'legacy-seed',kind:'import',at:'2026-01-01T00:00:00.000Z',data:{products:legacyProducts}});
  const edited=applyOperation(seeded,{id:'settings-change',kind:'settings',at:'2026-01-01T00:01:00.000Z',data:{name:'Mi ejemplo personalizado'}});
  assert.equal(isLegacyDemo(edited),false);
});

test('corrects the shop name on generated demo receipts without touching other demos',()=>{
  const profile=storeProfiles[0];let productId=0;
  const products=createDemoCatalog(profile,()=>`product-${productId++}`);
  let state=initialState();
  state=applyOperation(state,{id:'seed',kind:'import',at:'2026-01-01T00:00:00.000Z',data:{products}});
  for(const operation of createDemoSales(products,(()=>{let id=0;return ()=>`sale-${++id}`;})(),Date.parse('2026-01-01T01:00:00.000Z')))
    state=applyOperation(state,{...operation,at:operation.at,source:'PC'});
  assert.equal(demoFixtureNeedsShopName(state,profile),true);
  state.shop.name=profile.name;
  for(const sale of state.sales)sale.shop.name=profile.name;
  assert.equal(demoFixtureNeedsShopName(state,profile),false);
});
