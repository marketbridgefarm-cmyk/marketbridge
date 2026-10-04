# Inspection and transport work requirements

This patch adds a nullable JSONB `workDetails` field to `InspectionRequest` and `TransportJob`, preserving compatibility with existing rows and old clients.

## Inspection request fields
- `workDescription`
- `quantityToInspect`
- `lotCount`
- `checks` (allowlisted checklist values)
- `reportRequirements`
- `requiredBy`

## Transport request fields
- `weight`
- `packageCount`
- `vehicleType`
- `loadingHelp`
- `unloadingHelp`
- `handling` (allowlisted checklist values)
- `deliveryDeadline`
- `proofOfDelivery`

The existing sealed quote, selection, and negotiation routes remain in place. These fields describe the work and do not create or alter service payments. Deploy the migration before deploying the new backend/frontend, then regenerate Prisma Client during install/build as usual.
