import { StateStore } from "../../state/store.js";

export function listMappings(
  state: StateStore,
  options: {
    page: number;
    pageSize: number;
    search?: string;
    sortBy: "icloud_id" | "synced_at";
    sortOrder: "asc" | "desc";
  },
) {
  const totalItems = state.getCount(options.search);
  const totalPages = Math.max(1, Math.ceil(totalItems / options.pageSize));
  const page = Math.min(options.page, totalPages);
  const data = state.getMappingsPaginated({
    page,
    pageSize: options.pageSize,
    search: options.search,
    sortBy: options.sortBy,
    sortOrder: options.sortOrder,
  });

  return {
    data,
    pagination: {
      page,
      pageSize: options.pageSize,
      totalItems,
      totalPages,
    },
  };
}

export function deleteMapping(state: StateStore, icloudId: string): number {
  const mapping = state.getMapping(icloudId);
  if (!mapping) {
    return 0;
  }

  state.removeMapping(icloudId);
  return 1;
}

export function bulkDeleteMappings(
  state: StateStore,
  icloudIds: string[],
): number {
  return state.removeMappings(icloudIds);
}
