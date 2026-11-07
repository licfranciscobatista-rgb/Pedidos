import { getPool } from '@/lib/db';
import { createReceiptPdfBytes, type ReceiptPdfData } from '@/lib/inventory/receipt-pdf';
import { body, context, route } from '../../_shared';
import { ValidationError } from '@/lib/validation';
import { defaultStoreId, getStoreProfile, inventoryNamespace } from '@/public/caja/profiles.mjs';
import { demoSaleIsValid } from '@/public/caja/demo-fixtures.mjs';
import { saleAccounting } from '@/public/caja/domain.mjs';

export const dynamic = 'force-dynamic';

function sameOrigin(request: Request) {
  const expected = new URL(process.env.APP_ORIGIN || request.url).origin;
  const origin = request.headers.get('origin');
  if (origin && origin !== expected) throw new ValidationError('Esta solicitud debe hacerse desde la aplicación.', 403);
}

export async function POST(request: Request) {
  return route(async () => {
    const raw = await body(request) as Record<string, unknown>;
    const storeId = typeof raw.storeId === 'string' ? raw.storeId : defaultStoreId;
    const profile = getStoreProfile(storeId);
    if (!profile) throw new ValidationError('Selecciona un perfil de tienda válido.', 400);

    let sale: ReceiptPdfData;
    if (raw.demo === true) {
      sameOrigin(request);
      if (!demoSaleIsValid(raw.sale, profile)) throw new ValidationError('Este comprobante de demostración no es válido.', 400);
      sale = raw.sale as ReceiptPdfData;
    } else {
      const { ownerId: accountOwnerId } = await context(request, true);
      if (typeof raw.receiptId !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.receiptId)) {
        throw new ValidationError('El comprobante solicitado no es válido.', 400);
      }
      const scopedOwnerId = inventoryNamespace(accountOwnerId, storeId);
      if (!scopedOwnerId) throw new ValidationError('Selecciona un perfil de tienda válido.', 400);
      const result = await getPool().query<{ state: { sales: ReceiptPdfData[]; refunds?: ReceiptPdfData['refunds']; collections?: ReceiptPdfData['collections'] } | null }>(
        'SELECT state_json AS state FROM inventory_primary WHERE owner_id=$1', [scopedOwnerId],
      );
      const savedState = result.rows[0]?.state;
      const savedSale = savedState?.sales?.find(row => row.id === raw.receiptId);
      if (!savedSale) throw new ValidationError('Sincroniza el comprobante antes de descargarlo.', 404);
      const financials = saleAccounting(savedSale, savedState as never);
      sale = {
        ...savedSale,
        status: financials.status,
        netSalesCents: financials.netRevenueCents,
        collectedLaterCents: financials.collectedLaterCents,
        refundCents: financials.amountCents,
        cashRefundedCents: financials.cashRefundCents,
        balanceCents: financials.balanceCents,
        collections: (savedState?.collections || []).filter(item => item.saleId === savedSale.id),
        refunds: (savedState?.refunds || []).filter(item => item.saleId === savedSale.id),
      };
    }

    const bytes = await createReceiptPdfBytes(sale);
    const responseBytes = new Uint8Array(bytes.byteLength);
    responseBytes.set(bytes);
    const safeNumber = String(sale.number || 'comprobante').replace(/[^A-Za-z0-9-]/g, '_');
    return new Response(responseBytes.buffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${safeNumber}.pdf"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
