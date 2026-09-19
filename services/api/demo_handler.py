"""Demo access: a real Cognito session for one fixed, restricted identity.

Route:
    POST /demo/session    public — no Authorization header

Why this exists
---------------
A judge should be able to reach the product in one click. Three ways of doing that are ruled out:

* Putting demo credentials in the frontend. They would be in the bundle, in the repository, and in
  every browser devtools panel. The brief prohibits it and it would be wrong anyway.
* Bypassing Cognito with a synthetic token or local state. Then the demo is not the product — every
  authorization path downstream behaves differently, and the thing being demonstrated is a mock.
* A generic "sign in as" endpoint taking a username. That is an oracle for every account in the pool.

So: the browser asks the backend for a demo session with no parameters at all. The Lambda holds the
password in its own environment and authenticates **one hard-coded username** against the real user
pool. The browser receives the same tokens the SRP flow would have produced, and every downstream
authorization check behaves exactly as it does for a normal user.

Security properties
-------------------
* The username is a module constant, never read from the request. There is no input that changes
  which account is authenticated, so this cannot be used to probe or access anything else.
* The password lives in the function's environment, sourced from a ``NoEcho`` template parameter. It
  is never returned, logged, or included in an error.
* The identity is ``TEAM_MEMBER`` in the demo organization. It cannot approve, cannot touch budget,
  cannot manage teams, and has no AWS permissions of its own — the same restrictions any team member
  has, enforced by the same code.
* When the password is unset the endpoint refuses clearly and the login page hides the demo action,
  so a deployment without demo credentials degrades honestly rather than offering a broken button.
* The response carries only what a client needs to hold a session. No refresh token: a demo session
  that cannot be silently extended is the right trade, and the endpoint is one click away anyway.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

from services.shared.api_response import error, success
from services.shared.models.base import ErrorCategory

logger = logging.getLogger(__name__)

# The one identity this endpoint may authenticate. Deliberately a constant: if this were a request
# parameter the route would be a sign-in oracle for the whole user pool.
DEMO_USERNAME = os.environ.get("DEMO_USERNAME", "demo@communityops.local")

# Held in the function environment, from a NoEcho stack parameter. Absent means demo access is
# simply not configured for this deployment.
DEMO_PASSWORD = os.environ.get("DEMO_PASSWORD", "")

USER_POOL_ID = os.environ.get("USER_POOL_ID", "")
USER_POOL_CLIENT_ID = os.environ.get("USER_POOL_CLIENT_ID", "")
DEMO_ORGANIZATION_ID = os.environ.get("DEMO_ORGANIZATION_ID", "ORG-wemakedev")


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    if event.get("httpMethod") != "POST":
        return error(ErrorCategory.VALIDATION_ERROR, "Use POST to start a demo session.")
    return start_demo_session()


def start_demo_session() -> dict[str, Any]:
    """Authenticate the demo identity and return its tokens.

    Every failure mode returns a message written for the person who clicked the button, not for a
    developer reading logs. Cognito's own error text can name the account and the pool, so it is
    logged and not forwarded.
    """
    if not DEMO_PASSWORD or not USER_POOL_ID or not USER_POOL_CLIENT_ID:
        # Not an error in the deployment's own terms — it simply has no demo credentials. Said
        # plainly so the console can hide the action rather than surfacing a failure.
        logger.info("Demo access is not configured on this deployment")
        return error(
            ErrorCategory.NOT_FOUND,
            "Demo access is not configured on this deployment. Sign in with an account instead.",
        )

    try:
        cognito = boto3.client("cognito-idp")
        response = cognito.admin_initiate_auth(
            UserPoolId=USER_POOL_ID,
            ClientId=USER_POOL_CLIENT_ID,
            AuthFlow="ADMIN_NO_SRP_AUTH",
            AuthParameters={
                # Constant, not caller-supplied.
                "USERNAME": DEMO_USERNAME,
                "PASSWORD": DEMO_PASSWORD,
            },
        )
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        logger.error("Demo sign-in failed: %s", code, exc_info=True)
        if code in ("NotAuthorizedException", "UserNotFoundException"):
            # Both mean the demo identity is missing or its password has drifted from the stack
            # parameter. Reported as configuration rather than as a credential problem, because the
            # person clicking has no credentials to get wrong.
            return error(
                ErrorCategory.EXTERNAL_SERVICE_ERROR,
                "The demo account is not set up correctly on this deployment. "
                "Run scripts/setup-demo-users.py, or sign in with an account.",
            )
        if code == "TooManyRequestsException":
            return error(
                ErrorCategory.EXTERNAL_SERVICE_ERROR,
                "Too many demo sign-ins at once. Please try again in a moment.",
            )
        return error(
            ErrorCategory.EXTERNAL_SERVICE_ERROR,
            "The demo session could not be started. Please try again.",
        )

    # A challenge means the account needs attention before it can sign in — most often
    # NEW_PASSWORD_REQUIRED from a user created without a permanent password. There is no interactive
    # party to answer it, so it is a setup problem rather than something to prompt about.
    if challenge := response.get("ChallengeName"):
        logger.error("Demo account returned an auth challenge: %s", challenge)
        return error(
            ErrorCategory.EXTERNAL_SERVICE_ERROR,
            "The demo account needs to be finalised before it can be used. "
            "Run scripts/setup-demo-users.py to set a permanent password.",
        )

    tokens = response.get("AuthenticationResult") or {}
    id_token = tokens.get("IdToken")
    if not id_token:
        logger.error("Cognito returned no ID token for the demo account")
        return error(
            ErrorCategory.EXTERNAL_SERVICE_ERROR,
            "The demo session could not be started. Please try again.",
        )

    logger.info("Issued a demo session")
    return success(
        {
            # The API authorizer validates the ID token, so that is what the client needs.
            "id_token": id_token,
            "expires_in": int(tokens.get("ExpiresIn", 3600)),
            "email": DEMO_USERNAME,
            "organization_id": DEMO_ORGANIZATION_ID,
            # Stated so the console can label the workspace without decoding the token first, and so
            # it never renders leader-only affordances for a demo visitor.
            "role": "TEAM_MEMBER",
            "is_demo": True,
            "message": (
                "Signed in to the CommunityOps demo workspace as a team member. "
                "Consequential actions are reserved for community leaders."
            ),
        }
    )
