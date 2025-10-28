import sys
import fitz  # PyMuPDF
import os
import json

def convert_pdf_with_pymupdf(pdf_file_path, output_dir):
    if not os.path.exists(pdf_file_path):
        print(json.dumps({"error": f"File not found: {pdf_file_path}"}))
        sys.exit(1)

    os.makedirs(output_dir, exist_ok=True)
    page_paths = []

    try:
        doc = fitz.open(pdf_file_path)
        zoom_factor = 2.0
        matrix = fitz.Matrix(zoom_factor, zoom_factor)

        for page_num in range(len(doc)):
            page = doc.load_page(page_num)
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            image_filename = os.path.join(output_dir, f"page_{page_num+1}.jpg")
            pix.save(image_filename)
            page_paths.append(image_filename)

        doc.close()
        print(json.dumps({"success": True, "pages": page_paths}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: python convert_pdf_pymupdf.py <pdf_path> <output_dir>"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    output_dir = sys.argv[2]
    convert_pdf_with_pymupdf(pdf_path, output_dir)
