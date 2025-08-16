import { isLeft } from "fp-ts/lib/Either";
import * as reporter from "io-ts-reporters";
import type { NextApiRequest, NextApiResponse } from "next";

import { getAgentConfiguration } from "@app/lib/api/assistant/configuration/agent";
import { withSessionAuthenticationForWorkspace } from "@app/lib/api/auth_wrappers";
import type { Authenticator } from "@app/lib/auth";
import {
  generateRandomModelSId,
  getResourceIdFromSId,
} from "@app/lib/resources/string_ids";
import { TriggerResource } from "@app/lib/resources/trigger_resource";
import { apiError, withLogging } from "@app/logger/withlogging";
import type { WithAPIErrorResponse } from "@app/types";
import type {
  LightTriggerType,
  TriggerType,
} from "@app/types/assistant/triggers";
import { TriggerSchema } from "@app/types/assistant/triggers";

export interface GetTriggersResponseBody {
  triggers: LightTriggerType[];
}

export interface PatchTriggersRequestBody {
  triggers: Array<{
    name: string;
    description: string;
    kind: string;
    config: any;
    sId?: string;
  }>;
}

export interface PatchTriggersResponseBody {
  triggers: LightTriggerType[];
}

async function handler(
  req: NextApiRequest,
  res: NextApiResponse<
    WithAPIErrorResponse<GetTriggersResponseBody | PatchTriggersResponseBody>
  >,
  auth: Authenticator
): Promise<void> {
  const agentConfigurationId = req.query.aId as string;

  const agentConfiguration = await getAgentConfiguration(auth, {
    agentId: agentConfigurationId,
    variant: "light",
  });

  if (!agentConfiguration || !agentConfiguration.canRead) {
    return apiError(req, res, {
      status_code: 404,
      api_error: {
        type: "agent_configuration_not_found",
        message: "The agent configuration was not found.",
      },
    });
  }

  const triggers = await TriggerResource.listByAgentConfigurationId(
    auth,
    agentConfiguration.id
  );

  console.log(triggers);

  switch (req.method) {
    case "GET": {
      return res.status(200).json({
        triggers: triggers.map((trigger) => trigger.toSimpleJSON()),
      });
    }

    case "PATCH": {
      if (!agentConfiguration.canEdit && !auth.isAdmin()) {
        return apiError(req, res, {
          status_code: 403,
          api_error: {
            type: "app_auth_error",
            message: "Only editors can update triggers for this agent.",
          },
        });
      }

      console.log(req.body, req.body.triggers);

      if (
        !req.body ||
        !req.body.triggers ||
        !Array.isArray(req.body.triggers)
      ) {
        console.log("Invalid request body:", req.body);
        return apiError(req, res, {
          status_code: 400,
          api_error: {
            type: "invalid_request_error",
            message: "Request body must contain a 'triggers' array.",
          },
        });
      }

      const { triggers: requestTriggers } =
        req.body as PatchTriggersRequestBody;
      const workspace = auth.getNonNullableWorkspace();

      try {
        const currentTriggersMap = new Map(triggers.map((t) => [t.sId, t]));

        console.log("Current triggers:", currentTriggersMap);
        console.log("Request triggers:", requestTriggers);

        const resultTriggers: LightTriggerType[] = [];

        for (const triggerData of requestTriggers) {
          const bodyValidation = TriggerSchema.decode({
            name: triggerData.name,
            description: triggerData.description,
            kind: triggerData.kind,
            config: triggerData.config,
          });

          if (isLeft(bodyValidation)) {
            const pathError = reporter.formatValidationErrors(
              bodyValidation.left
            );
            return apiError(req, res, {
              status_code: 400,
              api_error: {
                type: "invalid_request_error",
                message: `Invalid trigger data: ${pathError}`,
              },
            });
          }

          const validatedTrigger = bodyValidation.right;

          if (triggerData.sId && currentTriggersMap.has(triggerData.sId)) {
            console.log("Updating existing trigger:", triggerData.sId);

            const existingTrigger = currentTriggersMap.get(triggerData.sId)!;
            const updatedTrigger = await TriggerResource.update(
              auth,
              existingTrigger.sId,
              {
                name: validatedTrigger.name,
                description: validatedTrigger.description,
                kind: validatedTrigger.kind,
                configuration: validatedTrigger.config || null,
              }
            );
            if (updatedTrigger.isErr()) {
              return apiError(req, res, {
                status_code: 500,
                api_error: {
                  type: "internal_server_error",
                  message: "Failed to update trigger.",
                },
              });
            }

            resultTriggers.push(updatedTrigger.value.toSimpleJSON());
            currentTriggersMap.delete(triggerData.sId);
          } else {
            console.log("Creating new trigger with random sId");
            const sId = generateRandomModelSId();
            const newTrigger = await TriggerResource.makeNew(auth, {
              sId,
              workspaceId: workspace.id,
              agentConfigurationId: agentConfiguration.sId,
              name: validatedTrigger.name,
              description: validatedTrigger.description,
              kind: validatedTrigger.kind,
              configuration: validatedTrigger.config || null,
            });
            resultTriggers.push(newTrigger.toSimpleJSON());
          }
        }

        for (const [, trigger] of currentTriggersMap) {
          console.log("Deleting unused trigger:", trigger.sId);
          await trigger.delete(auth);
        }

        return res.status(200).json({
          triggers: resultTriggers,
        });
      } catch (error) {
        return apiError(req, res, {
          status_code: 500,
          api_error: {
            type: "internal_server_error",
            message: "Failed to sync triggers.",
          },
        });
      }
    }

    default:
      return apiError(req, res, {
        status_code: 405,
        api_error: {
          type: "method_not_supported_error",
          message:
            "The method passed is not supported, GET, POST or PATCH is expected.",
        },
      });
  }
}

export default withLogging(withSessionAuthenticationForWorkspace(handler));
