import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getOrganizationContext, isMockMode } from "../api";
import {
  getSignedInUser,
  isAuthConfigured,
  isSignedIn,
  signOut as endCognitoSession,
} from "../auth";
import { SessionContext } from "./sessionContext";
import type { SessionStatus, SessionValue } from "./sessionContext";

export interface SessionProviderProps {
  children: ReactNode;
}

function initialStatus(): SessionStatus {
  if (isMockMode) return "authenticated";
  return isAuthConfigured ? "unresolved" : "configuration_error";
}

export function SessionProvider({ children }: SessionProviderProps) {
  const [status, setStatus] = useState<SessionStatus>(initialStatus);
  const [user, setUser] = useState<Awaited<ReturnType<typeof getSignedInUser>>>(null);
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (isMockMode) {
      try {
        const organization = await getOrganizationContext();
        setUser({
          userId: "mock-operator",
          email: "mock@communityops.local",
          name: "Mock Operator",
          role: "LEADER",
          organizations: [organization.organizationId],
          isDemo: false,
        });
        setActiveOrganizationId(organization.organizationId);
        setStatus("authenticated");
      } catch {
        setUser(null);
        setActiveOrganizationId(null);
        setStatus("authorization_error");
      }
      return;
    }

    if (!isAuthConfigured) {
      setUser(null);
      setActiveOrganizationId(null);
      setStatus("configuration_error");
      return;
    }

    const probe = (generation.current += 1);

    try {
      const signedIn = await isSignedIn();
      if (probe !== generation.current) return;

      if (!signedIn) {
        setUser(null);
        setActiveOrganizationId(null);
        setStatus("anonymous");
        return;
      }

      const resolvedUser = await getSignedInUser();
      if (probe !== generation.current) return;

      if (resolvedUser === null || resolvedUser.organizations.length === 0) {
        setUser(null);
        setActiveOrganizationId(null);
        setStatus("authorization_error");
        return;
      }

      const organization = await getOrganizationContext();
      if (probe !== generation.current) return;

      if (
        !organization.selectable.includes(organization.organizationId) ||
        !resolvedUser.organizations.includes(organization.organizationId)
      ) {
        setUser(null);
        setActiveOrganizationId(null);
        setStatus("authorization_error");
        return;
      }

      setUser(resolvedUser);
      setActiveOrganizationId(organization.organizationId);
      setStatus("authenticated");
    } catch (error: unknown) {
      if (probe !== generation.current) return;

      const status =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 401
          ? "anonymous"
          : "authorization_error";
      setUser(null);
      setActiveOrganizationId(null);
      setStatus(status);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  const signOut = useCallback(() => {
    generation.current += 1;
    endCognitoSession();
    setUser(null);
    setActiveOrganizationId(null);
    setStatus("anonymous");
  }, []);

  const session = useMemo<SessionValue>(
    () => ({ status, user, activeOrganizationId, refresh, signOut }),
    [activeOrganizationId, refresh, signOut, status, user],
  );

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
