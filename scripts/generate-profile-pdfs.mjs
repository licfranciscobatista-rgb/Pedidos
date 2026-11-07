import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {initialState,applyOperation} from '../public/caja/domain.mjs';
import {storeProfiles} from '../public/caja/profiles.mjs';
import {createDemoCatalog,createDemoSales} from '../public/caja/demo-fixtures.mjs';
import {createReceiptPdfBytes} from '../lib/inventory/receipt-pdf.ts';

const output=resolve(process.argv[2]||resolve(process.cwd(),'..','..','pruebas-pdf-perfiles'));
await mkdir(output,{recursive:true});
for(const profile of storeProfiles){
  let id=0;
  const makeId=()=>`${profile.slug}-${++id}`;
  const catalog=createDemoCatalog(profile,makeId);
  const state=initialState();state.shop.name=profile.name;
  let seeded=applyOperation(state,{id:makeId(),at:new Date().toISOString(),kind:'import',data:{products:catalog}});
  for(const operation of createDemoSales(catalog,makeId))seeded=applyOperation(seeded,operation);
  const compiled=await PDFDocument.create();
  for(const sale of seeded.sales){
    const sample=await PDFDocument.load(await createReceiptPdfBytes(sale));
    const pages=await compiled.copyPages(sample,sample.getPageIndices());
    pages.forEach(page=>compiled.addPage(page));
  }
  const filename=`${profile.slug}-40-comprobantes-de-prueba.pdf`;
  const bytes=await compiled.save();
  const verified=await PDFDocument.load(bytes);
  if(verified.getPageCount()!==40)throw new Error(`${filename}: el PDF no contiene 40 páginas.`);
  await writeFile(resolve(output,filename),bytes);
  process.stdout.write(`${filename}: ${seeded.products.length} artículos, ${seeded.sales.length} comprobantes, ${verified.getPageCount()} páginas, PDF verificado\n`);
}
