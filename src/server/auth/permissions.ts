export type Role = 'customer' | 'staff' | 'pharmacist' | 'admin';

/**
 * Role → permission matrix. Every admin route declares one permission and the
 * router enforces it before the handler runs.
 *
 * Prescription documents are restricted to pharmacists (data minimisation);
 * admins see review status but cannot open the files.
 */
const MATRIX = {
  'admin.access': ['admin', 'staff', 'pharmacist'],
  'dashboard.sales': ['admin', 'staff'],
  'products.manage': ['admin', 'staff'],
  'taxonomy.manage': ['admin', 'staff'],
  'inventory.manage': ['admin', 'staff'],
  'orders.manage': ['admin', 'staff'],
  'returns.manage': ['admin', 'staff'],
  'messages.view': ['admin', 'staff'],
  'customers.view': ['admin'],
  'coupons.manage': ['admin'],
  'reports.view': ['admin'],
  'audit.view': ['admin'],
  'settings.manage': ['admin'],
  'users.manage': ['admin'],
  'rx.queue': ['pharmacist', 'admin'],
  'rx.review': ['pharmacist'],
  'rx.documents': ['pharmacist'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof MATRIX;

export function can(role: Role | null | undefined, perm: Permission): boolean {
  if (!role) return false;
  return (MATRIX[perm] as readonly Role[]).includes(role);
}

export const ALL_PERMISSIONS = Object.keys(MATRIX) as Permission[];
