import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,applyOperation,saleAccounting} from '../public/caja/domain.mjs';
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

test('la factura de caja del demo admite varios artículos, pago parcial y muestra una devolución en su PDF',async()=>{
  const profile=storeProfiles[0],products=createDemoCatalog(profile,(()=>{let i=0;return()=>`pdf-ui-${++i}`;})());
  let state=initialState();state.shop.name=profile.name;
  state=applyOperation(state,{id:'pdf-ui-import',at:'2026-11-01T10:00:00.000Z',kind:'import',data:{products}});
  const items=products.slice(0,2).map(product=>({productId:product.id,quantity:1000}));
  const total=products[0].unitCents+products[1].unitCents;
  state=applyOperation(state,{id:'pdf-ui-sale',at:'2026-11-01T11:00:00.000Z',kind:'sale',data:{items,expectedPrices:Object.fromEntries(products.slice(0,2).map(p=>[p.id,p.unitCents])),customer:'Cliente real de prueba',paidCents:total,method:'Efectivo'}});
  state=applyOperation(state,{id:'pdf-ui-refund',at:'2026-11-01T12:00:00.000Z',kind:'refund',data:{saleId:'pdf-ui-sale',items:[{productId:products[0].id,quantity:500,restock:true}],method:'Efectivo',note:'Prueba de devolución parcial'}});
  const sale=state.sales[0],financials=saleAccounting(sale,state);
  const pdfSale={...sale,status:financials.status,netSalesCents:financials.netRevenueCents,refundCents:financials.amountCents,cashRefundedCents:financials.cashRefundCents,balanceCents:financials.balanceCents,collections:state.collections.filter(row=>row.saleId===sale.id),refunds:state.refunds.filter(row=>row.saleId===sale.id)};
  assert.equal(demoSaleIsValid(pdfSale,profile),true);
  assert.equal(financials.status,'Parcialmente devuelta');
  assert.equal(financials.cashRefundCents,Math.round(products[0].unitCents/2));
  const pdf=await createReceiptPdfBytes(pdfSale);
  const parsed=await PDFDocument.load(pdf);
  assert.equal(parsed.getPageCount(),1);
});
