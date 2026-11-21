from contextlib import asynccontextmanager

from app.asgi import app, application_lifespan
import greenroom_managed

greenroom_managed.install(app)
app.router.routes.sort(key=lambda route: 0 if getattr(route, 'path', '').startswith('/api/greenroom/') else 1)

@asynccontextmanager
async def lifespan(application):
    async with application_lifespan(application):
        greenroom_managed.restore()
        yield

app.router.lifespan_context = lifespan
