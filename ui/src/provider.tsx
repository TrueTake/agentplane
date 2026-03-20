"use client";

import React, { createContext, useContext, useMemo, useRef } from "react";
import type {
  AgentPlaneClient,
  AgentPlaneProviderProps,
  LinkComponentProps,
} from "./types";

/* ------------------------------------------------------------------ */
/*  Context types                                                      */
/* ------------------------------------------------------------------ */

interface ClientContextValue {
  client: AgentPlaneClient;
  onAuthError?: ((error: Error) => void) | undefined;
}

interface NavigationContextValue {
  onNavigate: (path: string) => void;
  LinkComponent: React.ComponentType<LinkComponentProps>;
  basePath: string;
}

/* ------------------------------------------------------------------ */
/*  Contexts — split to prevent unnecessary re-renders                 */
/* ------------------------------------------------------------------ */

/** @internal */
export const ClientContext = createContext<ClientContextValue | null>(null);

/** @internal */
export const NavigationContext = createContext<NavigationContextValue | null>(
  null,
);

/* ------------------------------------------------------------------ */
/*  Default link component                                             */
/* ------------------------------------------------------------------ */

function DefaultLink({ href, children, className }: LinkComponentProps) {
  return (
    <a href={href} className={className}>
      {children}
    </a>
  );
}

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */

/**
 * AgentPlaneProvider — wraps your app with the AgentPlane client and
 * navigation contexts.
 *
 * Split into two contexts so that navigation-related changes (basePath,
 * LinkComponent) never cause data-fetching components to re-render and
 * vice-versa.
 */
export function AgentPlaneProvider({
  client,
  onNavigate,
  LinkComponent = DefaultLink,
  onAuthError,
  basePath = "",
  children,
}: AgentPlaneProviderProps) {
  // Ensure referential stability of the client across re-renders.
  const clientRef = useRef(client);
  clientRef.current = client;

  const onAuthErrorRef = useRef(onAuthError);
  onAuthErrorRef.current = onAuthError;

  // Client context value — stable reference because we read from refs.
  const clientValue = useMemo<ClientContextValue>(
    () => ({
      // Expose a stable object whose `.client` always points to the latest ref.
      get client() {
        return clientRef.current;
      },
      get onAuthError() {
        return onAuthErrorRef.current;
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally stable
    [],
  );

  const navigationValue = useMemo<NavigationContextValue>(
    () => ({
      onNavigate,
      LinkComponent,
      basePath,
    }),
    [onNavigate, LinkComponent, basePath],
  );

  return (
    <ClientContext.Provider value={clientValue}>
      <NavigationContext.Provider value={navigationValue}>
        {children}
      </NavigationContext.Provider>
    </ClientContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/*  Hooks                                                              */
/* ------------------------------------------------------------------ */

/**
 * Returns the AgentPlane SDK client instance provided to the nearest
 * `<AgentPlaneProvider>`.
 */
export function useAgentPlaneClient(): AgentPlaneClient {
  const ctx = useContext(ClientContext);
  if (!ctx) {
    throw new Error(
      "useAgentPlaneClient must be used within an <AgentPlaneProvider>",
    );
  }
  return ctx.client;
}

/**
 * Returns the `onAuthError` callback (if any) from the nearest provider.
 * Useful inside data-fetching hooks for handling 401 responses.
 */
export function useAuthError(): ((error: Error) => void) | undefined {
  const ctx = useContext(ClientContext);
  if (!ctx) {
    throw new Error(
      "useAuthError must be used within an <AgentPlaneProvider>",
    );
  }
  return ctx.onAuthError;
}

/**
 * Returns navigation helpers from the nearest `<AgentPlaneProvider>`.
 */
export function useNavigation(): NavigationContextValue {
  const ctx = useContext(NavigationContext);
  if (!ctx) {
    throw new Error(
      "useNavigation must be used within an <AgentPlaneProvider>",
    );
  }
  return ctx;
}
