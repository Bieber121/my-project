-- Region memories, photo metadata, Storage bucket, and owner-only write policies.
-- Run once in the Supabase SQL editor for the project used by index.html.

create table if not exists public.region_details (
  owner_id uuid not null references auth.users(id) on delete cascade,
  region_id text not null,
  title text not null,
  note text not null default '',
  updated_at timestamptz not null default now(),
  primary key (owner_id, region_id),
  constraint region_details_region_id_length check (char_length(region_id) between 1 and 100),
  constraint region_details_note_length check (char_length(note) <= 4000)
);

create table if not exists public.region_photos (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  region_id text not null,
  storage_path text not null unique,
  thumbnail_path text,
  sort_order integer not null default 0,
  is_cover boolean not null default false,
  created_at timestamptz not null default now(),
  constraint region_photos_region_id_length check (char_length(region_id) between 1 and 100)
);

create index if not exists region_photos_region_order_idx
  on public.region_photos(owner_id, region_id, sort_order, created_at);

create unique index if not exists region_photos_one_cover_idx
  on public.region_photos(owner_id, region_id)
  where is_cover;

create or replace function public.touch_region_details_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists region_details_touch_updated_at on public.region_details;
create trigger region_details_touch_updated_at
before update on public.region_details
for each row execute function public.touch_region_details_updated_at();

alter table public.region_details enable row level security;
alter table public.region_photos enable row level security;

drop policy if exists "Public can read zuoyu region details" on public.region_details;
create policy "Public can read zuoyu region details"
on public.region_details for select to anon, authenticated
using (
  exists (
    select 1 from public.public_state ps
    where ps.slug = 'zuoyu' and ps.owner_id = region_details.owner_id
  )
);

drop policy if exists "Owner can insert zuoyu region details" on public.region_details;
create policy "Owner can insert zuoyu region details"
on public.region_details for insert to authenticated
with check (
  owner_id = auth.uid()
  and exists (
    select 1 from public.public_state ps
    where ps.slug = 'zuoyu' and ps.owner_id = auth.uid()
  )
);

drop policy if exists "Owner can update zuoyu region details" on public.region_details;
create policy "Owner can update zuoyu region details"
on public.region_details for update to authenticated
using (
  owner_id = auth.uid()
  and exists (
    select 1 from public.public_state ps
    where ps.slug = 'zuoyu' and ps.owner_id = auth.uid()
  )
)
with check (owner_id = auth.uid());

drop policy if exists "Owner can delete zuoyu region details" on public.region_details;
create policy "Owner can delete zuoyu region details"
on public.region_details for delete to authenticated
using (
  owner_id = auth.uid()
  and exists (
    select 1 from public.public_state ps
    where ps.slug = 'zuoyu' and ps.owner_id = auth.uid()
  )
);

drop policy if exists "Public can read zuoyu region photos" on public.region_photos;
create policy "Public can read zuoyu region photos"
on public.region_photos for select to anon, authenticated
using (
  exists (
    select 1 from public.public_state ps
    where ps.slug = 'zuoyu' and ps.owner_id = region_photos.owner_id
  )
);

drop policy if exists "Owner can insert zuoyu region photos" on public.region_photos;
create policy "Owner can insert zuoyu region photos"
on public.region_photos for insert to authenticated
with check (
  owner_id = auth.uid()
  and exists (
    select 1 from public.public_state ps
    where ps.slug = 'zuoyu' and ps.owner_id = auth.uid()
  )
);

drop policy if exists "Owner can update zuoyu region photos" on public.region_photos;
create policy "Owner can update zuoyu region photos"
on public.region_photos for update to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists "Owner can delete zuoyu region photos" on public.region_photos;
create policy "Owner can delete zuoyu region photos"
on public.region_photos for delete to authenticated
using (owner_id = auth.uid());

grant select on public.region_details, public.region_photos to anon, authenticated;
grant insert, update, delete on public.region_details, public.region_photos to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'region-photos',
  'region-photos',
  true,
  15728640,
  array['image/webp', 'image/jpeg']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public can view region photos" on storage.objects;
create policy "Public can view region photos"
on storage.objects for select to anon, authenticated
using (bucket_id = 'region-photos');

drop policy if exists "Owner can upload region photos" on storage.objects;
create policy "Owner can upload region photos"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'region-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
  and exists (
    select 1 from public.public_state ps
    where ps.slug = 'zuoyu' and ps.owner_id = auth.uid()
  )
);

drop policy if exists "Owner can delete region photos" on storage.objects;
create policy "Owner can delete region photos"
on storage.objects for delete to authenticated
using (
  bucket_id = 'region-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
  and exists (
    select 1 from public.public_state ps
    where ps.slug = 'zuoyu' and ps.owner_id = auth.uid()
  )
);

create or replace function public.set_region_cover(p_region_id text, p_photo_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.region_photos
    where id = p_photo_id and owner_id = auth.uid() and region_id = p_region_id
  ) then
    raise exception 'Photo is not owned by the current region owner';
  end if;

  update public.region_photos
  set is_cover = (id = p_photo_id)
  where owner_id = auth.uid() and region_id = p_region_id;
end;
$$;

create or replace function public.delete_region_photo_metadata(p_photo_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  deleted_region_id text;
  deleted_was_cover boolean;
begin
  select region_id, is_cover
  into deleted_region_id, deleted_was_cover
  from public.region_photos
  where id = p_photo_id and owner_id = auth.uid();

  if deleted_region_id is null then
    raise exception 'Photo is not owned by the current region owner';
  end if;

  delete from public.region_photos
  where id = p_photo_id and owner_id = auth.uid();

  if deleted_was_cover then
    update public.region_photos
    set is_cover = true
    where id = (
      select id from public.region_photos
      where owner_id = auth.uid() and region_id = deleted_region_id
      order by sort_order, created_at
      limit 1
    );
  end if;
end;
$$;

revoke all on function public.set_region_cover(text, uuid) from public;
revoke all on function public.delete_region_photo_metadata(uuid) from public;
grant execute on function public.set_region_cover(text, uuid) to authenticated;
grant execute on function public.delete_region_photo_metadata(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'region_details'
  ) then
    alter publication supabase_realtime add table public.region_details;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'region_photos'
  ) then
    alter publication supabase_realtime add table public.region_photos;
  end if;
end $$;
