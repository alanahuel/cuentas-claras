"""Local PDF/Tesseract extraction; suggestions always require human review."""

import io
import shutil
import subprocess
import tempfile
from pathlib import Path

import pymupdf
from PIL import Image, ImageOps, UnidentifiedImageError

from .document_fields import parse_fields

Image.MAX_IMAGE_PIXELS = 24000000


def read_image(image):
    if not shutil.which("tesseract"):
        return "", "OCR no instalado. Completa los campos manualmente."
    image = ImageOps.exif_transpose(image).convert("RGB")
    image.thumbnail((3000, 3000))
    if max(image.size) < 1600:
        scale = min(2, 1600 / max(image.size))
        image = image.resize(
            (round(image.width * scale), round(image.height * scale)),
            Image.Resampling.LANCZOS,
        )
    image = ImageOps.autocontrast(ImageOps.grayscale(image))
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "page.png"
        image.save(path)
        try:
            languages = subprocess.run(
                ["tesseract", "--list-langs"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            ).stdout
            result = subprocess.run(
                [
                    "tesseract",
                    str(path),
                    "stdout",
                    "-l",
                    "spa+eng" if "spa" in languages else "eng",
                ],
                capture_output=True,
                text=True,
                timeout=35,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return "", "La lectura tardó demasiado. Completa los campos manualmente."
        except OSError:
            return (
                "",
                "El lector OCR no está disponible. Completa los campos manualmente.",
            )
        return (
            result.stdout,
            ""
            if result.returncode == 0
            else "No se ha podido leer la imagen. Completa los campos manualmente.",
        )


def extract(content, kind="expense"):
    warning = ""
    try:
        if content.startswith(b"%PDF-"):
            mime = "application/pdf"
            with pymupdf.open(stream=content, filetype="pdf") as doc:
                if doc.needs_pass:
                    raise ValueError("El PDF está protegido con contraseña.")
                if len(doc) > 8:
                    raise ValueError("Admite hasta 8 páginas por documento.")
                parts = []
                for page in doc:
                    text = page.get_text(sort=True)
                    if len(text.strip()) < 30:
                        if page.rect.width * page.rect.height > 10000000:
                            raise ValueError("La página es demasiado grande.")
                        scale = min(
                            2,
                            (8000000 / max(page.rect.width * page.rect.height, 1))
                            ** 0.5,
                        )
                        pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale))
                        text, note = read_image(
                            Image.open(io.BytesIO(pix.tobytes("png")))
                        )
                        warning = note or warning
                    parts.append(text)
                text = "\n".join(parts)
        else:
            with Image.open(io.BytesIO(content)) as image:
                if image.format not in ("PNG", "JPEG", "WEBP"):
                    raise ValueError("Usa PDF, JPG, PNG o WebP.")
                mime = Image.MIME[image.format]
                if image.width * image.height > 24000000:
                    raise ValueError("La imagen supera 24 megapíxeles.")
                image.load()
                text, warning = read_image(image)
    except (
        UnidentifiedImageError,
        OSError,
        Image.DecompressionBombError,
        pymupdf.FileDataError,
    ):
        raise ValueError("No se reconoce el archivo. Usa una imagen válida o un PDF.")
    if not text.strip():
        warning = (
            warning or "No se ha detectado texto. Introduce los datos manualmente."
        )
    result = parse_fields(text[:25000], kind)
    return {
        "mime": mime,
        "text": text[:25000],
        **result,
        "warning": warning,
        "engine": "PDF/Tesseract local",
        "review_required": True,
    }
