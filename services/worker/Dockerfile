FROM python:3.11-slim
WORKDIR /app
# The package has to exist before the install: an editable install resolves
# its packages at install time, and with app/ still missing setuptools finds
# nothing to install.
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir .
# Copied after the install, not before: specs/ is data the parameter loader
# reads at runtime, not a Python package, and setuptools' flat-layout
# discovery mistakes a second top-level directory for one if it is present
# at install time.
COPY specs ./specs
CMD ["python", "-m", "app.main"]
