const productsByStore = {
  'libreria-valencia': [['Cuaderno rayado',6500],['Lápiz HB',1200],['Bolígrafo azul',1800],['Borrador blanco',1500],['Regla 30 cm',2500],['Marcador permanente',3500],['Carpeta plástica',4200],['Resaltador amarillo',2800],['Tijera escolar',5000],['Papel bond · resma',19500]],
  'electronica-valencia': [['Cable USB-C',7500],['Cargador 20 W',18500],['Audífonos estéreo',24500],['Mouse inalámbrico',22500],['Memoria USB 32 GB',16500],['Adaptador HDMI',19500],['Bocina Bluetooth',39900],['Protector de pantalla',9000],['Power bank 10 000 mAh',54500],['Teclado compacto',47500]],
  'decoraciones-valencia': [['Jarrón cerámico',32500],['Lámpara de mesa',64500],['Cojín decorativo',18500],['Marco para foto',12500],['Vela aromática',9500],['Florero de vidrio',27500],['Planta artificial',21500],['Espejo decorativo',58500],['Canasta tejida',29500],['Cuadro decorativo',72000]],
};

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
  if (!sale || sale.shop?.name!==profile.name || !/^V-\d{7}$/.test(sale.number||'') || sale.status!=='Confirmada' || !/^Cliente de prueba [1-4]$/.test(sale.customer||'') || !Array.isArray(sale.items) || sale.items.length!==1) return false;
  const [item]=sale.items;
  return typeof sale.id==='string' && Number.isFinite(Date.parse(sale.at)) &&
    typeof item?.sku==='string' && item.sku.startsWith(profile.slug.slice(0,3).toUpperCase()+'-') &&
    Number.isSafeInteger(item.quantity) && item.quantity===1000 &&
    Number.isSafeInteger(item.unitCents) && item.unitCents>0 &&
    item.totalCents===item.unitCents && sale.totalCents===item.totalCents &&
    sale.paidCents>=sale.totalCents && sale.changeCents===sale.paidCents-sale.totalCents;
}
