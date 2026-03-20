"use client";

import React from "react";

const PAGE_SIZE_OPTIONS = [10, 20, 50];

function PaginationBtn({
  href,
  children,
  onClick,
  LinkComponent,
}: {
  href: string | null;
  children: React.ReactNode;
  onClick?: ((href: string) => void) | undefined;
  LinkComponent?: React.ComponentType<{ href: string; children: React.ReactNode; className?: string }> | undefined;
}) {
  const cls = "inline-flex items-center justify-center h-7 w-7 rounded border border-border text-xs font-medium transition-colors";
  if (!href) return <span className={`${cls} text-muted-foreground opacity-40 cursor-not-allowed`}>{children}</span>;

  if (LinkComponent) {
    return <LinkComponent href={href} className={`${cls} hover:bg-muted`}>{children}</LinkComponent>;
  }

  if (onClick) {
    return <button className={`${cls} hover:bg-muted`} onClick={() => onClick(href)}>{children}</button>;
  }

  return <a href={href} className={`${cls} hover:bg-muted`}>{children}</a>;
}

export function PaginationBar({
  page,
  pageSize,
  total,
  buildHref,
  onNavigate,
  LinkComponent,
}: {
  page: number;
  pageSize: number;
  total: number;
  buildHref: (page: number, pageSize: number) => string;
  onNavigate?: (href: string) => void;
  LinkComponent?: React.ComponentType<{ href: string; children: React.ReactNode; className?: string }>;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function renderLink(href: string, children: React.ReactNode, extraClass: string) {
    if (LinkComponent) {
      return <LinkComponent href={href} className={extraClass}>{children}</LinkComponent>;
    }
    if (onNavigate) {
      return <button className={extraClass} onClick={() => onNavigate(href)}>{children}</button>;
    }
    return <a href={href} className={extraClass}>{children}</a>;
  }

  return (
    <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-muted/20 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span>Rows per page:</span>
        {PAGE_SIZE_OPTIONS.map((ps) => (
          <React.Fragment key={ps}>
            {renderLink(
              buildHref(1, ps),
              ps,
              `px-2 py-0.5 rounded text-xs ${pageSize === ps ? "bg-primary text-primary-foreground font-medium" : "hover:bg-muted"}`,
            )}
          </React.Fragment>
        ))}
        <span className="ml-2">{total} total</span>
      </div>

      <div className="flex items-center gap-1">
        <PaginationBtn href={page > 1 ? buildHref(1, pageSize) : null} onClick={onNavigate} LinkComponent={LinkComponent}>&laquo;</PaginationBtn>
        <PaginationBtn href={page > 1 ? buildHref(page - 1, pageSize) : null} onClick={onNavigate} LinkComponent={LinkComponent}>&lsaquo;</PaginationBtn>
        <span className="px-3 text-xs text-muted-foreground">Page {page} of {totalPages}</span>
        <PaginationBtn href={page < totalPages ? buildHref(page + 1, pageSize) : null} onClick={onNavigate} LinkComponent={LinkComponent}>&rsaquo;</PaginationBtn>
        <PaginationBtn href={page < totalPages ? buildHref(totalPages, pageSize) : null} onClick={onNavigate} LinkComponent={LinkComponent}>&raquo;</PaginationBtn>
      </div>
    </div>
  );
}

export function parsePaginationParams(
  pageParam: string | undefined,
  pageSizeParam: string | undefined,
  defaultPageSize = 20,
) {
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(pageSizeParam)) ? Number(pageSizeParam) : defaultPageSize;
  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}
