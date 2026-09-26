import type { UserRole } from '@prisma/client';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { hashPassword } from './passwords.js';

const DEMO_USERS: Array<{ login: string; fullName: string; role: UserRole; password: () => string }> = [
  { login: 'admin', fullName: 'Администратор системы', role: 'ADMIN', password: () => config.demoPasswords.admin },
  { login: 'inspector', fullName: 'Смирнов А.В.', role: 'INSPECTOR', password: () => config.demoPasswords.inspector },
  { login: 'supervisor', fullName: 'Петрова Е.И.', role: 'SUPERVISOR', password: () => config.demoPasswords.supervisor },
  { login: 'ml', fullName: 'ML-инженер', role: 'ML_ENGINEER', password: () => config.demoPasswords.ml },
];

// Only an empty table is seeded. Once anyone exists, accounts are managed by
// people, and recreating a deleted demo account on restart would undo that.
export async function seedDemoUsers(): Promise<number> {
  if ((await prisma.user.count()) > 0) return 0;
  for (const user of DEMO_USERS) {
    await prisma.user.create({
      data: {
        login: user.login,
        fullName: user.fullName,
        role: user.role,
        passwordHash: await hashPassword(user.password()),
      },
    });
  }
  return DEMO_USERS.length;
}
