import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowData,
  type RowSelectionState,
  type SortingState,
  type OnChangeFn,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, FilterX, Inbox } from "lucide-react";
import { useTableUrlState } from "@/hooks/useUrlState";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/form-controls";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/menus";
import { EmptyState, ErrorState, SkeletonRows } from "./misc";

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    align?: "left" | "right" | "center";
    label?: string;
    className?: string;
    headerClassName?: string;
  }
}

export interface DataTableProps<T> {
  data: T[] | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<T, any>[];
  getRowId: (row: T) => string;
  ariaLabel: string;
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onRowClick?: (row: T) => void;
  activeRowId?: string;
  /** Row selection (controlled). Adds a checkbox column when provided. */
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: OnChangeFn<RowSelectionState>;
  canSelectRow?: (row: T) => boolean;
  renderExpanded?: (row: T) => React.ReactNode;
  expandedIds?: Set<string>;
  emptyState?: React.ReactNode;
  isFiltered?: boolean;
  onClearFilters?: () => void;
  urlKey?: string;
  defaultSort?: SortingState;
  maxHeight?: string;
  toolbar?: React.ReactNode;
  rowClassName?: (row: T) => string | undefined;
  footer?: React.ReactNode;
}

export function DataTable<T>({
  data,
  columns,
  getRowId,
  ariaLabel,
  isLoading,
  error,
  onRetry,
  onRowClick,
  activeRowId,
  rowSelection,
  onRowSelectionChange,
  canSelectRow,
  renderExpanded,
  expandedIds,
  emptyState,
  isFiltered,
  onClearFilters,
  urlKey = "",
  defaultSort = [],
  maxHeight = "calc(100vh - 320px)",
  toolbar,
  rowClassName,
  footer,
}: DataTableProps<T>) {
  const density = useUiStore((s) => s.density);
  const { sorting, setSorting, columnVisibility, setColumnVisibility } = useTableUrlState(urlKey, defaultSort);
  const selectable = !!onRowSelectionChange;

  const allColumns = React.useMemo<ColumnDef<T, unknown>[]>(() => {
    if (!selectable) return columns;
    const selectCol: ColumnDef<T, unknown> = {
      id: "_select",
      enableSorting: false,
      enableHiding: false,
      size: 36,
      header: ({ table }) => (
        <Checkbox
          aria-label="Select all rows"
          checked={table.getIsAllRowsSelected() ? true : table.getIsSomeRowsSelected() ? "indeterminate" : false}
          onCheckedChange={(v) => table.toggleAllRowsSelected(!!v)}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label="Select row"
          checked={row.getIsSelected()}
          disabled={!row.getCanSelect()}
          onClick={(e) => e.stopPropagation()}
          onCheckedChange={(v) => row.toggleSelected(!!v)}
        />
      ),
    };
    return [selectCol, ...columns];
  }, [columns, selectable]);

  const table = useReactTable({
    data: data ?? [],
    columns: allColumns,
    getRowId: (r) => getRowId(r),
    state: { sorting, columnVisibility, rowSelection: rowSelection ?? {} },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange,
    enableRowSelection: canSelectRow ? (row) => canSelectRow(row.original) : selectable,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rows = table.getRowModel().rows;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const rowHeight = density === "compact" ? 32 : 44;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    getItemKey: (i) => rows[i]?.id ?? i,
  });
  React.useEffect(() => {
    virtualizer.measure();
  }, [density, expandedIds, virtualizer]);

  const items = virtualizer.getVirtualItems();
  const padTop = items.length ? items[0].start : 0;
  const padBottom = items.length ? virtualizer.getTotalSize() - items[items.length - 1].end : 0;
  const colCount = table.getVisibleLeafColumns().length;

  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide() && c.columnDef.meta?.label);

  const body = (() => {
    if (isLoading) return <SkeletonRows cols={Math.min(colCount, 6)} />;
    if (error) return <ErrorState error={error} onRetry={onRetry} />;
    if (!rows.length) {
      if (isFiltered)
        return (
          <EmptyState
            icon={FilterX}
            title="No results for these filters"
            description="Try widening the ranges or clearing a filter."
            action={
              onClearFilters && (
                <Button size="sm" variant="secondary" onClick={onClearFilters}>
                  Clear filters
                </Button>
              )
            }
          />
        );
      return emptyState ?? <EmptyState icon={Inbox} title="Nothing here yet" />;
    }
    return null;
  })();

  return (
    <div className="flex flex-col">
      {(toolbar || hideable.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <div className="flex flex-1 flex-wrap items-center gap-2">{toolbar}</div>
          {hideable.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="Choose visible columns">
                  <Columns3 /> <span className="hidden sm:inline">Columns</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
                {hideable.map((c) => (
                  <DropdownMenuCheckboxItem
                    key={c.id}
                    checked={c.getIsVisible()}
                    onCheckedChange={(v) => c.toggleVisibility(!!v)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {c.columnDef.meta?.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      <div ref={scrollRef} className="relative overflow-auto touch-scroll" style={{ maxHeight }}>
        <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm" aria-label={ariaLabel} aria-rowcount={rows.length + 1}>
          <thead className="sticky top-0 z-10 bg-surface">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const meta = h.column.columnDef.meta;
                  const sorted = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      scope="col"
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                      style={{ width: h.column.columnDef.size !== 150 ? h.getSize() : undefined }}
                      className={cn(
                        "dt-cell whitespace-nowrap border-b text-2xs font-semibold uppercase tracking-wider text-muted-foreground",
                        meta?.align === "right" && "text-right",
                        meta?.align === "center" && "text-center",
                        meta?.headerClassName,
                      )}
                    >
                      {h.isPlaceholder ? null : h.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={h.column.getToggleSortingHandler()}
                          className={cn(
                            "inline-flex items-center gap-1 uppercase hover:text-foreground",
                            meta?.align === "right" && "flex-row-reverse",
                          )}
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {sorted === "asc" ? (
                            <ArrowUp className="h-3 w-3" aria-hidden />
                          ) : sorted === "desc" ? (
                            <ArrowDown className="h-3 w-3" aria-hidden />
                          ) : (
                            <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />
                          )}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          {body ? (
            <tbody>
              <tr>
                <td colSpan={colCount}>{body}</td>
              </tr>
            </tbody>
          ) : (
            <>
              {padTop > 0 && (
                <tbody aria-hidden>
                  <tr style={{ height: padTop }} />
                </tbody>
              )}
              {items.map((vi) => {
                const row = rows[vi.index];
                const expanded = renderExpanded && expandedIds?.has(row.id);
                return (
                  <tbody key={row.id} ref={virtualizer.measureElement} data-index={vi.index}>
                    <tr
                      aria-rowindex={vi.index + 2}
                      aria-selected={selectable ? row.getIsSelected() : undefined}
                      tabIndex={onRowClick ? 0 : undefined}
                      onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                      onKeyDown={
                        onRowClick
                          ? (e) => {
                              if (e.key === "Enter" && e.target === e.currentTarget) onRowClick(row.original);
                            }
                          : undefined
                      }
                      className={cn(
                        "dt-row group transition-colors duration-100",
                        onRowClick && "cursor-pointer hover:bg-surface-2/60 focus-visible:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sys",
                        row.getIsSelected() && "bg-sys/5",
                        activeRowId === row.id && "bg-surface-2",
                        rowClassName?.(row.original),
                      )}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const meta = cell.column.columnDef.meta;
                        return (
                          <td
                            key={cell.id}
                            className={cn(
                              "dt-cell border-b border-border/60 align-middle",
                              meta?.align === "right" && "text-right",
                              meta?.align === "center" && "text-center",
                              meta?.className,
                            )}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        );
                      })}
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={colCount} className="border-b bg-background/60 p-0">
                          {renderExpanded!(row.original)}
                        </td>
                      </tr>
                    )}
                  </tbody>
                );
              })}
              {padBottom > 0 && (
                <tbody aria-hidden>
                  <tr style={{ height: padBottom }} />
                </tbody>
              )}
            </>
          )}
        </table>
      </div>
      {footer ?? (
        !body && (
          <div className="flex flex-wrap items-center justify-between gap-1 border-t px-3 py-1.5 text-2xs text-muted-foreground">
            <span>
              {rows.length.toLocaleString()} row{rows.length === 1 ? "" : "s"}
              {selectable && Object.keys(rowSelection ?? {}).length > 0 && ` · ${Object.keys(rowSelection ?? {}).length} selected`}
            </span>
            <span className="text-2xs text-muted-foreground/60 sm:hidden">Swipe horizontally for all columns →</span>
          </div>
        )
      )}
    </div>
  );
}
