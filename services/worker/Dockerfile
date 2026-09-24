FROM python:3.11-slim
WORKDIR /app
# The package has to exist before the install: an editable install resolves
# its packages at install time, and with app/ still missing setuptools finds
# nothing to install.
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir .
CMD ["python", "-m", "app.main"]
