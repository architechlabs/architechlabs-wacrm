import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, type PDFObject } from 'pdf-lib';
import { DocumentDeliveryError } from './contracts';

export async function validateDocumentPdf(pdf: Uint8Array): Promise<void> {
  try {
    const document = await PDFDocument.load(pdf, { updateMetadata:false });
    if (document.getPageCount() < 1 || document.getPageCount() > 100) throw new Error();
    const forbidden = ['JavaScript','JS','OpenAction','AA','EmbeddedFiles','Launch','RichMedia','XFA'];
    const visited = new Set<PDFObject>();
    function inspect(object: PDFObject, depth: number) {
      if (visited.has(object)) return;
      if (depth > 40) throw new Error();
      visited.add(object);
      if (object instanceof PDFDict) {
        if (forbidden.some(key => object.has(PDFName.of(key)))) throw new Error();
        for (const [, child] of object.entries()) inspect(child,depth+1);
      } else if (object instanceof PDFArray) {
        for (const child of object.asArray()) inspect(child,depth+1);
      } else if (object instanceof PDFRawStream) inspect(object.dict,depth+1);
    }
    for (const [, object] of document.context.enumerateIndirectObjects()) inspect(object,0);
  } catch { throw new DocumentDeliveryError('invalid_static_pdf',400); }
}
