# Docker

The *Services* tool window shows your project's Docker Compose services, every container and every
image, and starts, stops and reads them. It uses the `docker` command on your `PATH` (Docker Desktop,
or Docker Engine on Linux).

Open it from *View ▸ Tool Windows ▸ Services*, <kbd>Ctrl+E</kbd>, or the whale icon in the tool
window strip.

To run your PHP, tests and debugger inside a container, choose a Docker or Docker Compose
interpreter in *Settings ▸ PHP*: see [Your first project](./first-project) and
[Debugging](./debugging).

## What it lists

- **Docker Compose**: the services of the project's `compose.yaml` (or `compose.yml`,
  `docker-compose.yml`, `docker-compose.yaml`), each with its container once it exists, running or
  not. The services are read from the file, so they're listed even while Docker isn't running.
- **Other Containers**: every other container on the machine.
- **Images**: with their tag, size and age.

The list refreshes on its own every few seconds while the window is open.

## What it does

- **Compose**: *Up* (`docker compose up -d`), *Restart* and *Down*, for all the services or one.
- **A container**: *Start*, *Stop*, *Restart*, *Remove* (asks first; its volumes stay), and *Copy
  exec*: a `docker exec -it … sh` command to paste in the [Terminal](./terminal).
- **An image**: *Remove* (asks first; Docker refuses while a container uses it).

Below the list:

- **Log**: the selected container's log, followed live.
- **Inspect**: `docker inspect` as JSON, searchable with <kbd>Ctrl+F</kbd>.
- **Output**: what the last action printed.

If Docker isn't installed or isn't running, the window says so instead of the list.
