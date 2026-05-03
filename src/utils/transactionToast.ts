import toast from 'react-hot-toast';
import { parseSolanaError } from './errorParser';

export type TransactionToastOptions<T = unknown> = {
  /** If set, shown on success instead of the default success toast. */
  successMessage?: string | ((result: T) => string);
  /** Toast duration in ms when a custom success message is used (default 4000). */
  successDuration?: number;
  /** If set, shown on failure (non-user-rejection) instead of parsed error text. */
  errorMessage?: string;
};

function resolveSuccessContent<T>(
  options: TransactionToastOptions<T> | undefined,
  res: T,
): string | undefined {
  const sm = options?.successMessage;
  if (typeof sm === 'function') return sm(res);
  return sm;
}

export async function withTransactionToast<T>(
  label: string,
  fn: () => Promise<T>,
  options?: TransactionToastOptions<T>,
): Promise<T> {
  const id = toast.loading(label);
  try {
    const res = await fn();
    toast.dismiss(id);
    const sig =
      res && typeof res === 'object' && 'signature' in res && typeof (res as { signature?: string }).signature === 'string'
        ? (res as { signature: string }).signature
        : undefined;
    const custom = resolveSuccessContent(options, res);
    if (sig) {
      if (custom) {
        toast.success(custom, { duration: options?.successDuration ?? 4000 });
      } else {
        toast.success('Success', { duration: 6000 });
      }
    } else {
      toast.success(custom ?? 'Done');
    }
    return res;
  } catch (e) {
    toast.dismiss(id);
    const parsed = parseSolanaError(e);
    if (parsed.isUserRejection) {
      toast('Cancelled', { icon: '—' });
    } else {
      toast.error(options?.errorMessage ?? parsed.message);
    }
    throw e;
  }
}
