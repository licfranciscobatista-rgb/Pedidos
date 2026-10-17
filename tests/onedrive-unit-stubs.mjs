// The planning and cryptography tests do not open authentication sessions,
// network connections or database pools. SQL execution is covered separately
// by the PostgreSQL integration suite.
export const ORDER_COLUMNS = "id";
export const PAYMENT_COLUMNS = "id";
export const EXCHANGE_COLUMNS = "id";
export async function boundedBody() { throw new Error("Not used by these unit tests"); }
