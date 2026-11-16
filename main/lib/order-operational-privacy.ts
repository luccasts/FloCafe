// Operational diagnostics are intentionally independent of response/business records.
export function reportOrderOperationalFailure(
  operation: 'create' | 'append' | 'discount',
  _error: unknown,
  operationCommitted: boolean,
): void {
  console.error('FLOCAFE_ORDER_DIAGNOSTIC', {
    operation,
    code: 'order_operation_failed',
    operationCommitted,
  });
}
