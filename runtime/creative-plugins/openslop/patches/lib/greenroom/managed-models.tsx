'use client';
import type { ReactNode } from 'react';
import { installManagedModels } from '@/lib/connectors/models';
export function ManagedModels({config,children}:{config:any;children:ReactNode}) { installManagedModels(config); return children; }
