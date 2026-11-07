const productsByStore = {
  'libreria-valencia': [['Cuaderno rayado',6500],['Lápiz HB',1200],['Bolígrafo azul',1800],['Borrador blanco',1500],['Regla 30 cm',2500],['Marcador permanente',3500],['Carpeta plástica',4200],['Resaltador amarillo',2800],['Tijera escolar',5000],['Papel bond · resma',19500]],
  'electronica-valencia': [['Cable USB-C',7500],['Cargador 20 W',18500],['Audífonos estéreo',24500],['Mouse inalámbrico',22500],['Memoria USB 32 GB',16500],['Adaptador HDMI',19500],['Bocina Bluetooth',39900],['Protector de pantalla',9000],['Power bank 10 000 mAh',54500],['Teclado compacto',47500]],
  'decoraciones-valencia': [['Jarrón cerámico',32500],['Lámpara de mesa',64500],['Cojín decorativo',18500],['Marco para foto',12500],['Vela aromática',9500],['Florero de vidrio',27500],['Planta artificial',21500],['Espejo decorativo',58500],['Canasta tejida',29500],['Cuadro decorativo',72000]],
};

export function isLegacyDemo(state) {
  return state?.products?.length===3 && state.sales?.length===0 && state.operations?.length===4 &&
    ['ARR-001','ACE-001','JAB-001'].every(sku=>state.products.some(product=>product.sku===sku));
}

export function demoFixtureNeedsShopName(state, profile) {
  const prefix=profile.slug.slice(0,3).toUpperCase()+'-';
  return state?.shop?.name==='Mi tienda' && state.products?.length===10 && state.sales?.length===40 &&
    state.products.every(product=>product.sku.startsWith(prefix)) &&
    state.sales.every(sale=>sale.shop?.name==='Mi tienda' && /^Cliente de prueba [1-4]$/.test(sale.customer||'') &&
      sale.items?.length===1 && sale.items[0].sku.startsWith(prefix));
}

export function createDemoCatalog(profile, makeId = () => crypto.randomUUID()) {
  const entries = productsByStore[profile.slug] || productsByStore['libreria-valencia'];
  return entries.map(([name,unitCents],i)=>({id:makeId(),sku:`${profile.slug.slice(0,3).toUpperCase()}-${String(i+1).padStart(3,'0')}`,name,category:profile.name,unitCents,costCents:Math.round(unitCents*.62),stock:20000,minStock:5000,active:true,barcode:''}));
}

export function createDemoSales(products, makeId = () => crypto.randomUUID(), now = Date.now()) {
  let invoiceIndex=0;
  return products.flatMap(product=>[1,2,3,4].map(saleIndex=>{
    invoiceIndex++;
    return {id:makeId(),at:new Date(now-(40-invoiceIndex)*60_000).toISOString(),kind:'sale',source:'PC',data:{items:[{productId:product.id,quantity:1000}],expectedPrices:{[product.id]:product.unitCents},customer:`Cliente de prueba ${saleIndex}`,method:['Efectivo','Tarjeta','Transferencia','Efectivo'][saleIndex-1],paidCents:product.unitCents}};
  }));
}

export function demoSaleIsValid(sale, profile) {
  if (!sale || sale.shop?.name!==profile.name || !/^(?:V-\d{7}|INT-\d{4}-\d{7})$/.test(sale.number||'') ||
      !['Confirmada','Anulada','Pagada','Pendiente de pago','Parcialmente devuelta','Devuelta'].includes(sale.status) || !Array.isArray(sale.items) || !sale.items.length || sale.items.length>500 ||
      typeof sale.id!=='string' || !sale.id || !Number.isFinite(Date.parse(sale.at)) ||
      typeof sale.customer!=='string' || sale.customer.length>160 ||
      !Number.isSafeInteger(sale.totalCents) || sale.totalCents<0 ||
      !Number.isSafeInteger(sale.paidCents) || sale.paidCents<0 ||
      !Number.isSafeInteger(sale.changeCents) || sale.changeCents<0 ||
      sale.paidCents<sale.totalCents || sale.changeCents!==sale.paidCents-sale.totalCents) return false;

  const prefix=profile.slug.slice(0,3).toUpperCase()+'-';
  let total=0;
  for(const item of sale.items){
    if(typeof item?.sku!=='string' || !item.sku.startsWith(prefix) ||
       !Number.isSafeInteger(item.quantity) || item.quantity<=0 ||
       !Number.isSafeInteger(item.unitCents) || item.unitCents<0 ||
       !Number.isSafeInteger(item.totalCents) || item.totalCents!==Math.round(item.unitCents*item.quantity/1000)) return false;
    total+=item.totalCents;
    if(!Number.isSafeInteger(total)) return false;
  }
  if(total!==sale.totalCents) return false;

  // Legacy V-numbered fixtures are deliberately kept narrow. INT-numbered
  // invoices follow the same multi-item/partial-payment rules as the POS.
  if(sale.number.startsWith('V-')) return sale.items.length===1 && /^Cliente de prueba [1-4]$/.test(sale.customer) &&
    sale.items[0].quantity===1000 && sale.items[0].unitCents>0;
  return true;
}
