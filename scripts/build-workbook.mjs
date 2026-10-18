import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The authoring library belongs to the Codex workspace runtime, not production.
// CODEX_WORKSPACE_NODE_MODULES may point to its node_modules directory.
const require = createRequire(process.env.CODEX_WORKSPACE_NODE_MODULES
  ? path.join(process.env.CODEX_WORKSPACE_NODE_MODULES, '_workbook-builder.cjs')
  : import.meta.url);
const { FileBlob, SpreadsheetFile, Workbook } = await import(pathToFileURL(require.resolve('@oai/artifact-tool')).href);
function argument(name) { const index = process.argv.indexOf(name); if (index < 0) return ''; const value = process.argv[index + 1]; if (!value || value.startsWith('--')) throw new Error(`Missing ${name} value.`); return path.resolve(value); }
const sourcePath = argument('--source');
const targetPath = argument('--output') || fileURLToPath(new URL('../public/plantilla-pedidos.xlsx', import.meta.url));
const previewPath = argument('--previews');
const publicPath = fileURLToPath(new URL('../public/', import.meta.url));
const insidePublic = target => { const relative = path.relative(publicPath,target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
if (sourcePath && (!argument('--output') || insidePublic(targetPath) || previewPath && insidePublic(previewPath))) throw new Error('Private --source requires --output and --previews outside public/.');
const original = sourcePath ? await SpreadsheetFile.importXlsx(await FileBlob.load(sourcePath)) : null;
if (process.argv.includes('--inspect')) {
  if (!original) throw new Error('--inspect requires --source.');
  console.log((await original.inspect({ kind: 'workbook,sheet,table', maxChars: 3200, tableMaxRows: 3, tableMaxCols: 7 })).ndjson);
  console.log((await original.inspect({ kind: 'table', range: 'Sheet1!A1:O30', include: 'values,formulas', maxChars: 5000, tableMaxRows: 25, tableMaxCols: 15 })).ndjson);
  const preview = await original.render({ sheetName: 'Sheet1', range: 'A1:L24', scale: 1.3, format: 'png' });
  if (previewPath) { await fs.mkdir(previewPath, {recursive:true}); await fs.writeFile(path.join(previewPath,'referencia-sheet1-original.png'),new Uint8Array(await preview.arrayBuffer())); }
  process.exit(0);
}
const origin = 'https://temu-pedidos-franc.onrender.com/';
await fs.mkdir(path.dirname(targetPath), { recursive: true });
if (previewPath) await fs.mkdir(previewPath, {recursive:true});
const rawOrders = original ? original.worksheets.getItem('Pedidos').getRange('A1:U3').values : [[]];
const sourceHeaders = rawOrders[0];
const sourceOrders = rawOrders.slice(1).filter(row => row[0]).map(row => Object.fromEntries(sourceHeaders.map((key, index) => [key, row[index]])));
const originalValues = original ? original.worksheets.getItem('Sheet1').getRange('A1:N21').values : [];
const colors = { ink: '#243A31', green: '#355D49', pale: '#EEF4EE', input: '#FFF9E9', calc: '#EFF2F4', blue: '#19639C', muted: '#65756B' };
const currency = '"RD$ "#,##0.00;[Red]("RD$ "#,##0.00);"RD$ "0.00';
const asDate = value => value instanceof Date ? value : typeof value === 'number' ? new Date(Math.round((value - 25569) * 86400000)) : new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
const clients = [...new Map(sourceOrders.map(order => [`${order.Cliente}|${order['Teléfono'] || ''}`, order])).values()].map((order, index) => ({ id: `CLI-${String(index + 1).padStart(3, '0')}`, name: order.Cliente, phone: order['Teléfono'] || '' }));
const names = ['Inicio', 'Clientes', 'Pedidos', 'Precios', 'Pagos', 'Cotizaciones', 'DetalleCotizaciones', 'Facturas', 'DetalleFacturas', 'FacturasEmitidas', 'DetalleEmitidas', 'Cambios', 'Listas', 'Guía'];
const definitions = {
  Clientes: ['ID Cliente','Cliente','Teléfono','Correo','Dirección','Activo','Notas','Revisión'],
  Pedidos: ['ID Pedido','ID Cliente','Fecha','Artículo','Unidades','Estado','Foto','Notas','Plataforma','Variante','Fecha de entrega','Lote','Revisión'],
  Precios: ['ID Pedido','Precio unitario','Cargos extra','Descuento','Pagado a tienda','Total a cobrar','Pagado por cliente','Saldo pendiente','ID Cliente (calculado)'],
  Pagos: ['ID Pago','ID Pedido','Tipo','Monto','Fecha','Medio','Nota'],
  Cotizaciones: ['ID Cotización','ID Cliente','Fecha','Válida hasta','Estado','Notas','Revisión','Total'],
  DetalleCotizaciones: ['ID Línea','ID Cotización','Artículo','Variante','Plataforma','Unidades','Precio unitario','Cargos extra','Descuento','Importe'],
  Facturas: ['ID Borrador','ID Cliente','Fecha','Nombre del negocio','Modo de precio','Monto manual','Mostrar importes','Notas','Revisión','Estado (calculado)','Factura emitida (calculada)'],
  DetalleFacturas: ['ID Borrador','ID Pedido','Aviso de entrega'],
  FacturasEmitidas: ['ID Factura','Número','ID Cliente','Cliente','Teléfono','Fecha emisión','Nombre negocio','Modo precio','Mostrar importes','Total','Pagado','Saldo','Notas','ID Borrador'],
  DetalleEmitidas: ['ID Factura','ID Pedido','Artículo','Variante','Plataforma','Unidades','Precio unitario','Cargos extra','Descuento','Importe','Estado pedido','Aviso de entrega','Fecha pedido','Fecha entrega'],
  Cambios: ['ID Cambio','ID Pedido','Fecha','Artículo anterior','Artículo nuevo','Total anterior','Total nuevo','Diferencia','Nota'],
};
const maxRows = 204;
function column(index) { let result=''; for(let n=index+1;n>0;n=Math.floor((n-1)/26)) result=String.fromCharCode(65+(n-1)%26)+result; return result; }
function text(sheet, address, value) { sheet.getRange(address).values=[[value]]; }
function formula(sheet, address, value) { sheet.getRange(address).formulas=[[value]]; }
function list(sheet, address, values) { sheet.getRange(address).dataValidation={rule:{type:'list', ...(Array.isArray(values)?{values}:{formula1:values})}}; }
function base(wb, name, title, description) {
  const sheet=wb.worksheets.getItem(name);
  sheet.showGridLines=false;
  sheet.getRange(`A1:N${maxRows}`).format.font={name:'Arial',size:10,color:colors.ink};
  sheet.getRange(`A1:N${maxRows}`).format.rowHeight=22;
  text(sheet,'A1','Ver Inicio o Guía');
  sheet.getRange('A1').format.font={name:'Arial',size:9,color:colors.blue};
  text(sheet,'A2',title); sheet.getRange('A2').format.font={name:'Arial',size:15,bold:true,color:colors.ink};
  sheet.getRange('A2:N2').format.rowHeight=30;
  text(sheet,'A3',description); sheet.getRange('A3').format.font={name:'Arial',size:9,italic:true,color:colors.muted};
  return sheet;
}
function table(wb,name,description,widths) {
  const sheet=base(wb,name,name==='Facturas'?'Facturas por emitir':name,description), headers=definitions[name];
  sheet.getRange(`A4:${column(headers.length-1)}4`).values=[headers];
  const native=sheet.tables.add(`A4:${column(headers.length-1)}${maxRows}`,true,`${name.replace(/[^A-Za-z]/g,'')}Tabla`); native.style='TableStyleMedium4';
  sheet.getRange(`A4:${column(headers.length-1)}4`).format={fill:colors.green,font:{name:'Arial',size:10,bold:true,color:'#FFFFFF'},wrapText:true,rowHeight:34,verticalAlignment:'center'};
  sheet.getRange(`A5:${column(headers.length-1)}${maxRows}`).format.fill=colors.input;
  widths.forEach((width,i)=>sheet.getRange(`${column(i)}1:${column(i)}${maxRows}`).format.columnWidth=width);
  sheet.getRange('A3').values=[['']]; text(sheet,'B3',description); sheet.getRange(`B3:${column(headers.length-1)}3`).merge(); sheet.getRange(`B3:${column(headers.length-1)}3`).format={wrapText:true,rowHeight:35,font:{name:'Arial',size:9,italic:true,color:colors.muted}};
  sheet.freezePanes.freezeRows(4); sheet.freezePanes.freezeColumns(1);
  sheet.tabColor=['Clientes','Pedidos','Cotizaciones','Facturas'].includes(name)?colors.green:'#A7BBA8';
  return sheet;
}
async function build(empty=false) {
  const wb=Workbook.create(); for(const name of names) wb.worksheets.add(name);
  const client=table(wb,'Clientes','Una fila por cliente. Conserva su código para relacionarlo con pedidos y documentos.',[17,29,21,29,38,12,42,12]);
  const orders=table(wb,'Pedidos','Registra aquí el artículo y su estado. Escribe sus importes en Precios con el mismo ID Pedido.',[18,18,15,35,12,19,18,35,15,23,18,23,12]);
  const prices=table(wb,'Precios','B a E se escriben. F a I se calculan. Pagado a tienda es tu compra, no el abono del cliente.',[18,20,18,18,22,22,23,23,25]);
  const payments=table(wb,'Pagos','Cada abono o devolución tiene un ID Pago distinto y el ID Pedido al que corresponde.',[18,18,17,18,15,23,45]);
  const quotes=table(wb,'Cotizaciones','Propuestas al cliente. Sus artículos se registran en DetalleCotizaciones y no generan deuda.',[20,18,15,17,18,44,12,22]);
  const quoteLines=table(wb,'DetalleCotizaciones','Una fila por artículo de la cotización. El importe se calcula y se suma en Cotizaciones.',[18,20,36,26,16,12,20,18,18,22]);
  const drafts=table(wb,'Facturas','Borradores para revisar y emitir en la web. J y K muestran si ya se emitieron; no se escriben.',[19,18,15,29,23,21,20,42,12,22,29]);
  const draftLines=table(wb,'DetalleFacturas','Relaciona cada borrador con sus pedidos y el aviso de llegada de cada artículo.',[19,18,29]);
  const issued=table(wb,'FacturasEmitidas','Archivo de consulta enviado por la web. Las facturas se emiten y conservan en la web; no edites esta hoja.',[22,24,18,30,22,23,29,22,20,22,22,22,42,22]);
  const issuedLines=table(wb,'DetalleEmitidas','Artículos conservados al emitir cada factura. Hoja de consulta, actualizada desde la web.',[22,18,36,26,16,12,20,18,18,22,19,29,18,18]);
  issued.getRange('A5:N204').format.fill=colors.calc; issuedLines.getRange('A5:N204').format.fill=colors.calc;
  issued.getRange('F5:F1504').setNumberFormat('dd/mm/yyyy hh:mm'); issued.getRange('J5:L1504').setNumberFormat(currency);
  issuedLines.getRange('G5:J1504').setNumberFormat(currency); issuedLines.getRange('M5:N1504').setNumberFormat('dd/mm/yyyy');
  const changes=table(wb,'Cambios','Historial de sustituciones. Para un cambio nuevo, usa Cambiar artículo en la web.',[18,18,15,33,33,20,20,20,42]);
  const lists=base(wb,'Listas','Listas de selección','Catálogos que alimentan los desplegables. Mantén los estados tal como aparecen aquí.');
  const catalog=[['Estados de pedido','Plataformas','Tipos de pago','Medios de pago','Estado cotización','Modo de precio','Mostrar importes','Aviso de entrega'],['Pendiente','Temu','Abono','Efectivo','Borrador','Manual','Sí','Llega en esta entrega'],['Pedido','SHEIN','Devolución','Transferencia','Enviada','Precios registrados','No','Sigue pendiente'],['En camino',null,null,'Banreservas','Aceptada',null,null,'Ya entregado'],['Recibido',null,null,'BHD','Rechazada',null,null,'Por confirmar'],['Entregado',null,null,'Popular','Vencida'],['Cancelado',null,null,'MIO'],['Cambiado',null,null,'Tarjeta'],[null,null,null,'Otro']];
  lists.getRange('A4:H12').values=catalog.map(row=>Array.from({length:8},(_,i)=>row[i]??null)); lists.getRange('A4:H4').format={fill:colors.green,font:{name:'Arial',bold:true,color:'#FFFFFF'},rowHeight:34,wrapText:true}; lists.getRange('A1:H12').format.columnWidth=24;
  for(const [name,ref] of [['ClientesIDs',"'Clientes'!$A$5:$A$1504"],['PedidosIDs',"'Pedidos'!$A$5:$A$1504"],['CotizacionesIDs',"'Cotizaciones'!$A$5:$A$1504"],['BorradoresIDs',"'Facturas'!$A$5:$A$1504"]]) wb.names.add(name,`=${ref}`);
  list(client,'F5:F1504',['Sí','No']); list(orders,'B5:B1504','ClientesIDs'); list(orders,'F5:F1504',['Pendiente','Pedido','En camino','Recibido','Entregado','Cancelado','Cambiado']); list(orders,'I5:I1504',['Temu','SHEIN']);
  list(prices,'A5:A1504','PedidosIDs'); list(payments,'B5:B1504','PedidosIDs'); list(payments,'C5:C1504',['Abono','Devolución']); list(payments,'F5:F1504',['Efectivo','Transferencia','Banreservas','BHD','Popular','MIO','Tarjeta','Otro']);
  list(quotes,'B5:B1504','ClientesIDs'); list(quotes,'E5:E1504',['Borrador','Enviada','Aceptada','Rechazada','Vencida']); list(quoteLines,'B5:B1504','CotizacionesIDs'); list(quoteLines,'E5:E1504',['Temu','SHEIN']);
  list(drafts,'B5:B1504','ClientesIDs'); list(drafts,'E5:E1504',['Manual','Precios registrados']); list(drafts,'G5:G1504',['Sí','No']); list(draftLines,'A5:A1504','BorradoresIDs'); list(draftLines,'B5:B1504','PedidosIDs'); list(draftLines,'C5:C1504',['Llega en esta entrega','Sigue pendiente','Ya entregado','Por confirmar']); list(changes,'B5:B1504','PedidosIDs');
  for(const [sheet,ranges] of [[orders,['C5:C1504','K5:K1504']],[payments,['E5:E1504']],[quotes,['C5:D1504']],[drafts,['C5:C1504']],[changes,['C5:C1504']]]) for(const range of ranges) sheet.getRange(range).setNumberFormat('dd/mm/yyyy');
  for(const [sheet,range] of [[prices,'B5:H1504'],[payments,'D5:D1504'],[quotes,'H5:H1504'],[quoteLines,'G5:J1504'],[drafts,'F5:F1504'],[changes,'F5:H1504']]) sheet.getRange(range).setNumberFormat(currency);
  for(const [sheet,range] of [[client,'A5:C1504'],[orders,'A5:B1504'],[payments,'A5:B1504'],[quotes,'A5:B1504'],[drafts,'A5:B1504'],[quoteLines,'A5:B1504'],[draftLines,'A5:B1504']]) sheet.getRange(range).setNumberFormat('@');
  const priceFormula='=IF(A5="","",IF(COUNTIFS(Pedidos!$A$5:$A$10000,A5)<>1,"Revisar ID",IF(INDEX(Pedidos!$F$5:$F$10000,MATCH(A5,Pedidos!$A$5:$A$10000,0))="Cancelado",0,IF(B5="","Falta precio",ROUND(INDEX(Pedidos!$E$5:$E$10000,MATCH(A5,Pedidos!$A$5:$A$10000,0))*B5+C5-D5,2)))))';
  formula(prices,'F5',priceFormula); prices.getRange(`F5:F${maxRows}`).fillDown();
  formula(prices,'G5','=IF(A5="","",SUMIFS(Pagos!$D$5:$D$10000,Pagos!$B$5:$B$10000,A5,Pagos!$C$5:$C$10000,"Abono")-SUMIFS(Pagos!$D$5:$D$10000,Pagos!$B$5:$B$10000,A5,Pagos!$C$5:$C$10000,"Devolución"))'); prices.getRange(`G5:G${maxRows}`).fillDown();
  formula(prices,'H5','=IF(A5="","",IF(ISNUMBER(F5),F5-G5,"Revisar precio"))'); prices.getRange(`H5:H${maxRows}`).fillDown();
  formula(prices,'I5','=IF(A5="","",IF(COUNTIFS(Pedidos!$A$5:$A$10000,A5)=1,INDEX(Pedidos!$B$5:$B$10000,MATCH(A5,Pedidos!$A$5:$A$10000,0)),"Revisar ID"))'); prices.getRange(`I5:I${maxRows}`).fillDown();
  formula(quotes,'H5','=IF(A5="","",SUMIFS(DetalleCotizaciones!$J$5:$J$10000,DetalleCotizaciones!$B$5:$B$10000,A5))'); quotes.getRange(`H5:H${maxRows}`).fillDown();
  formula(quoteLines,'J5','=IF(A5="","",IF(OR(F5="",G5=""),"Falta cantidad o precio",ROUND(F5*G5+H5-I5,2)))'); quoteLines.getRange(`J5:J${maxRows}`).fillDown();
  formula(changes,'H5','=IF(A5="","",G5-F5)'); changes.getRange(`H5:H${maxRows}`).fillDown();
  formula(drafts,'J5','=IF(A5="","",IF(COUNTIFS(FacturasEmitidas!$N$5:$N$10000,A5)>0,"Emitida","Borrador"))'); drafts.getRange(`J5:J${maxRows}`).fillDown();
  formula(drafts,'K5','=IF(A5="","",IF(COUNTIFS(FacturasEmitidas!$N$5:$N$10000,A5)>0,INDEX(FacturasEmitidas!$B$5:$B$10000,MATCH(A5,FacturasEmitidas!$N$5:$N$10000,0)),""))'); drafts.getRange(`K5:K${maxRows}`).fillDown(); drafts.getRange(`J5:K${maxRows}`).format.fill=colors.calc;
  for(const [sheet,range] of [[prices,`F5:I${maxRows}`],[quotes,`H5:H${maxRows}`],[quoteLines,`J5:J${maxRows}`],[changes,`H5:H${maxRows}`]]) sheet.getRange(range).format.fill=colors.calc;
  orders.getRange(`A5:A${maxRows}`).conditionalFormats.add('duplicateValues',{format:{fill:'#FCE7E7',font:{color:'#A12626'}}});
  orders.getRange(`F5:F${maxRows}`).conditionalFormats.add('containsText',{text:'Entregado',format:{fill:'#DDEDDC',font:{color:'#215B32'}}});
  prices.getRange(`H5:H${maxRows}`).conditionalFormats.add('cellIs',{operator:'greaterThan',formula:0,format:{fill:'#FFF0CF',font:{color:'#885C17'}}});
  if(!empty) {
    client.getRange(`A5:H${4+clients.length}`).values=clients.map(person=>[person.id,person.name,person.phone,'','','Sí','Cliente de los pedidos de prueba existentes',0]);
    orders.getRange(`A5:M${4+sourceOrders.length}`).values=sourceOrders.map(item=>[item['ID Pedido'],clients.find(c=>c.name===item.Cliente&&c.phone===(item['Teléfono']||'')).id,asDate(item.Fecha),item['Artículo'],item.Unidades||1,item.Estado||'Pendiente',item.Foto||'',item.Notas||'',item.Plataforma||'Temu',item.Variante||'',item['Fecha de entrega']?asDate(item['Fecha de entrega']):null,item.Lote||'',item['Revisión']||0]);
    prices.getRange(`A5:E${4+sourceOrders.length}`).values=sourceOrders.map(item=>[item['ID Pedido'],item['Precio unitario'],item['Cargos extra']||0,item.Descuento||0,item['Pagado a tienda']||0]);
  }
  const home=base(wb,'Inicio','Mi encargo','Registra en las tablas. Consulta aquí los pedidos y las cuentas por cliente.'); home.tabColor=colors.green; home.getRange('A1:J46').format.columnWidth=16; home.getRange('J1:J46').format.columnWidth=22; home.getRange('A1').values=[['']];
  const cards=[['A5','Clientes','A6','=COUNTA(Clientes!$A$5:$A$10000)'],['D5','Artículos','D6','=COUNTA(Pedidos!$A$5:$A$10000)'],['G5','Total a cobrar','G6','=SUM(Precios!$F$5:$F$10000)'],['J5','Saldo pendiente','J6','=SUM(Precios!$H$5:$H$10000)'],['A9','Cotizaciones','A10','=COUNTA(Cotizaciones!$A$5:$A$10000)'],['D9','Facturas por emitir','D10','=COUNTIFS(Facturas!$J$5:$J$10000,"Borrador")'],['G9','Pagado por clientes','G10','=SUM(Precios!$G$5:$G$10000)'],['J9','Pagado a tienda','J10','=SUM(Precios!$E$5:$E$10000)']];
  for(const [labelAddress,label,valueAddress,value] of cards){text(home,labelAddress,label);formula(home,valueAddress,value);home.getRange(valueAddress).format.font={name:'Arial',size:16,bold:true,color:colors.green};home.getRange(labelAddress).format.font={name:'Arial',size:9,color:colors.muted};if(['G6','J6','G10','J10'].includes(valueAddress))home.getRange(valueAddress).setNumberFormat(currency);}
  text(home,'A13','Consultar cliente'); text(home,'G13','Consultar pedido'); list(home,'B14','ClientesIDs'); list(home,'H14','PedidosIDs'); home.getRange('B14:D14').format.fill=colors.input; home.getRange('H14:J14').format.fill=colors.input;
  if(!empty){text(home,'B14',clients[0].id);text(home,'H14',sourceOrders[0]['ID Pedido']);}
  for(const [cell,label] of [['A14','Código'],['A16','Cliente'],['A18','Teléfono'],['A20','Artículos'],['A22','Por cobrar'],['G14','Código'],['G16','Artículo'],['G18','Fecha pedido'],['G20','Estado'],['G22','Total'],['G24','Saldo']])text(home,cell,label);
  formula(home,'B16','=IF(B14="","",IF(COUNTIFS(Clientes!$A$5:$A$10000,B14)=1,INDEX(Clientes!$B$5:$B$10000,MATCH(B14,Clientes!$A$5:$A$10000,0)),"Cliente no encontrado"))');
  formula(home,'B18','=IF(B14="","",IF(COUNTIFS(Clientes!$A$5:$A$10000,B14)=1,IF(INDEX(Clientes!$C$5:$C$10000,MATCH(B14,Clientes!$A$5:$A$10000,0))="","Sin teléfono",INDEX(Clientes!$C$5:$C$10000,MATCH(B14,Clientes!$A$5:$A$10000,0))),"Cliente no encontrado"))');
  formula(home,'B20','=IF(B14="","",COUNTIFS(Pedidos!$B$5:$B$10000,B14))'); formula(home,'B22','=IF(B14="","",SUMIFS(Precios!$H$5:$H$10000,Precios!$I$5:$I$10000,B14))'); home.getRange('B22').setNumberFormat(currency);
  for(const [cell,col] of [['H16','D'],['H18','C'],['H20','F']])formula(home,cell,`=IF(H14="","",IF(COUNTIFS(Pedidos!$A$5:$A$10000,H14)=1,INDEX(Pedidos!$${col}$5:$${col}$10000,MATCH(H14,Pedidos!$A$5:$A$10000,0)),"Pedido no encontrado"))`);
  home.getRange('H18').setNumberFormat('dd/mm/yyyy');
  for(const [cell,col] of [['H22','F'],['H24','H']]){formula(home,cell,`=IF(H14="","",IF(COUNTIFS(Precios!$A$5:$A$10000,H14)=1,INDEX(Precios!$${col}$5:$${col}$10000,MATCH(H14,Precios!$A$5:$A$10000,0)),"Precio no registrado"))`);home.getRange(cell).setNumberFormat(currency);}
  const nav=['Clientes','Pedidos','Precios','Pagos','Cotizaciones','DetalleCotizaciones','Facturas','DetalleFacturas','FacturasEmitidas','DetalleEmitidas','Cambios','Guía'];
  text(home,'A27','Registros · abre la pestaña correspondiente en la parte inferior'); for(let i=0;i<nav.length;i++){const address=`${i%2===0?'A':'G'}${29+Math.floor(i/2)*2}`;text(home,address,nav[i]);home.getRange(address).format.font={name:'Arial',size:11,bold:true,color:colors.green};}
  text(home,'A43','Mi encargo en la web'); text(home,'A44',origin); home.getRange('A44').format.font={name:'Arial',size:11,bold:true,color:colors.blue};
  const guide=base(wb,'Guía','Cómo trabajar con el libro','Las tablas están relacionadas por códigos. Las celdas amarillas se escriben y las grises se calculan.');
  const instructions=[['Clientes','Crea primero CLI-001, CLI-002 y sus nombres. Selecciona ese código en pedidos, cotizaciones y borradores.'],['Pedidos','Una fila por artículo. Usa códigos únicos y permanentes. El Estado y la Plataforma tienen listas desplegables.'],['Precios','Usa el mismo ID Pedido. Escribe precio unitario, cargos, descuento y lo pagado a la tienda.'],['Pagos','Anota Abono o Devolución y el medio: Efectivo, Transferencia, Banreservas, BHD, Popular o MIO. No cambies un pago ya sincronizado.'],['Cotizaciones','Escribe la cabecera y luego sus artículos en DetalleCotizaciones. Cotizar no crea deuda ni un pedido comprado.'],['Facturas','Registra un borrador y sus pedidos en DetalleFacturas. Revísalo en la web y pulsa Emitir. El borrador no es una factura emitida.'],['Fotos','Inserta JPG o PNG en la columna Foto de la fila del pedido. El libro completo admite hasta 5 MB.'],['Códigos y revisiones','Conserva los códigos. Deja la revisión en cero al crear. Si editaste también en la web, revisa el conflicto antes de importar.'],['Cambios de artículo','Registra el cambio desde la web para conservar el artículo anterior, el nuevo y los pagos.'],['Actualizar la web','Guarda Excel Online. Con lectura y escritura autorizadas, la web sincroniza en ambos sentidos al abrirse y cada 60 segundos mientras esté visible.'],['Facturas emitidas','Consulta FacturasEmitidas y DetalleEmitidas. La web conserva su número y contenido original; no edites estas hojas grises.'],['Capacidad del libro','Hay 200 filas preparadas por tabla. Se admiten 1,500 pedidos/clientes/documentos y 3,000 pagos por libro; añade filas dentro de las tablas y conserva las fórmulas grises.']];
  guide.getRange('A4:B15').values=instructions;guide.getRange('A4:A15').format={columnWidth:27,font:{name:'Arial',size:10,bold:true,color:colors.green}};guide.getRange('B4:B15').format={columnWidth:100,wrapText:true,rowHeight:40};guide.freezePanes.freezeRows(3);
  if(!empty){const reference=wb.worksheets.add('Referencia original');reference.showGridLines=false;reference.getRange('A1:N21').values=originalValues;reference.getRange('A1:N24').format={font:{name:'Arial',size:10},columnWidth:23,rowHeight:24};reference.getRange('B6:J6').format.borders={preset:'all',style:'thin',color:'#222222'};reference.getRange('B14:E14').format.borders={preset:'all',style:'thin',color:'#222222'};reference.getRange('I17:N17').format.borders={preset:'all',style:'thin',color:'#222222'};}
  wb.recalculate();
  console.log((await wb.inspect({kind:'table',range:'Inicio!A5:J24',include:'values,formulas',maxChars:1500,tableMaxRows:20,tableMaxCols:10})).ndjson);
  const errors=await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!',options:{useRegex:true,maxResults:10},summary:'Formula errors'}); console.log(errors.ndjson);
  await(await SpreadsheetFile.exportXlsx(wb)).save(targetPath);
  await fs.rm(`${targetPath}.inspect.ndjson`,{force:true});
  if(previewPath)for(const name of [...names,...(!empty?['Referencia original']:[])]){const last=name==='Inicio'?'J46':name==='Guía'?'B15':name==='Listas'?'H12':name==='Referencia original'?'N24':`${column(definitions[name].length-1)}10`;const preview=await wb.render({sheetName:name,range:`A1:${last}`,scale:name==='Inicio'?1.2:1,format:'png'});await fs.writeFile(path.join(previewPath,`preview-${name}.png`),new Uint8Array(await preview.arrayBuffer()));}
  console.log(JSON.stringify({saved:targetPath,empty,sheets:names.length+(!empty?1:0)}));
}
await build(!original);
