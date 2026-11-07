import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,applyOperation} from '../public/caja/domain.mjs';
import {storeProfiles} from '../public/caja/profiles.mjs';
import {createDemoCatalog,createDemoSales,demoSaleIsValid} from '../public/caja/demo-fixtures.mjs';
import {createReceiptPdfBytes} from '../lib/inventory/receipt-pdf.ts';
import {PDFDocument} from 'pdf-lib';

test('cada perfil produce 10 artículos, 40 comprobantes, cuatro ventas por SKU y PDF válido',async()=>{
  for(const profile of storeProfiles){
    let id=0;
    const makeId=()=>`${profile.slug}-${++id}`;
    const products=createDemoCatalog(profile,makeId);
    const state=initialState();
    state.shop.name=profile.name;
    let seeded=applyOperation(state,{id:makeId(),at:new Date().toISOString(),kind:'import',data:{products}});
    const salesOps=createDemoSales(products,makeId,Date.now());
    for(const op of salesOps)seeded=applyOperation(seeded,op);
    assert.equal(seeded.products.length,10,profile.name);
    assert.equal(seeded.sales.length,40,profile.name);
    assert.ok(seeded.products.every(product=>product.stock===16000),profile.name);
    assert.ok(seeded.products.every(product=>seeded.sales.filter(sale=>sale.items.some(item=>item.productId===product.id)).length===4),profile.name);

    for(const sale of seeded.sales){
      assert.equal(demoSaleIsValid(sale,profile),true,`${profile.name} ${sale.number}`);
      const bytes=await createReceiptPdfBytes(sale);
      assert.equal(new TextDecoder().decode(bytes.slice(0,5)),'%PDF-',`${profile.name} ${sale.number}`);
      const pdf=await PDFDocument.load(bytes);
      assert.equal(pdf.getPageCount(),1,`${profile.name} ${sale.number}`);
    }
  }
});
