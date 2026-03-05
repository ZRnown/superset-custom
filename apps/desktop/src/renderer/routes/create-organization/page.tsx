import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/create-organization/")({
	component: CreateOrganization,
});

export function CreateOrganization() {
	return <Navigate to="/workspace" replace />;
}
