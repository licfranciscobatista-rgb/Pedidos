import {readFile} from 'node:fs/promises';
import {basename} from 'node:path';
import {PDFDocument} from 'pdf-lib';

const files=process.argv.slice(2);
if(!files.length)throw new Error('Pasa al menos un archivo PDF para verificar.');
for(const file of files){
  const bytes=await readFile(file);
  const pdf=await PDFDocument.load(bytes);
  if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error(`${basename(file)} no tiene cabecera PDF.`);
  console.log(`${basename(file)}: válido, ${pdf.getPageCount()} página(s), ${bytes.length} bytes`);
}
