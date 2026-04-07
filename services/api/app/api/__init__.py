from fastapi import APIRouter

from app.api.automation import router as automation_router
from app.api.command_tower import router as command_tower_router
from app.api.computer_use import router as computer_use_router
from app.api.embeddings import router as embeddings_router
from app.api.flows import router as flows_router
from app.api.health import router as health_router
from app.api.integrations_vonage import router as integrations_vonage_router
from app.api.profiles import router as profiles_router
from app.api.proof import router as proof_router
from app.api.register import router as register_router
from app.api.reconstruction import router as reconstruction_router
from app.api.runs import router as runs_router
from app.api.sessions import router as sessions_router
from app.api.templates import router as templates_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(integrations_vonage_router)
api_router.include_router(register_router)
api_router.include_router(automation_router)
api_router.include_router(command_tower_router)
api_router.include_router(computer_use_router)
api_router.include_router(embeddings_router)
api_router.include_router(reconstruction_router)
api_router.include_router(profiles_router)
api_router.include_router(proof_router)
api_router.include_router(sessions_router)
api_router.include_router(flows_router)
api_router.include_router(templates_router)
api_router.include_router(runs_router)
