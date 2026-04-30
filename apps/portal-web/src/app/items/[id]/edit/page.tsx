import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import type { Item } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';
import { ItemForm } from '../../item-form';

interface Props {
  params: { id: string };
}

export const metadata = { title: 'Edit item' };

export default async function EditItemPage({ params }: Props) {
  let item: Item;
  try {
    item = await apiFetch<Item>(`/api/items/${params.id}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }

  // Only the owner or an org admin should land here. The API would also
  // reject the PATCH, but we keep the client-side gate so we don't render
  // a form that's going to 403 on submit.
  const me = await apiFetch<{ id: string; orgRole: string }>('/api/users/me');
  const canManage = me.id === item.ownerId || me.orgRole === 'admin';
  if (!canManage) redirect(`/items/${item.id}`);

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <Link
        href={`/items/${item.id}`}
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to item
      </Link>

      <header className="mb-8">
        <p className="text-sm text-muted">Editing</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          {item.title}
        </h1>
      </header>

      <ItemForm
        mode={{ kind: 'edit', itemId: item.id }}
        initialValues={{
          type: item.type,
          title: item.title,
          description: item.description,
          tags: item.tags,
          access: item.access,
          thumbnailUrl: item.thumbnailUrl,
          license: item.license,
        }}
        initialData={item.data}
      />
    </div>
  );
}
