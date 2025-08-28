#!/usr/bin/env python3
"""
Resize the new JL logo for iOS app icon (180x180)
"""
from PIL import Image
import os

def resize_logo_for_ios():
    # Input and output paths
    input_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'assets', 'image.png')
    output_path = os.path.join(os.path.dirname(__file__), 'icon-180.png')
    
    try:
        # Open the original image
        with Image.open(input_path) as img:
            print(f"Original image size: {img.size}")
            
            # Resize to 180x180 with high-quality resampling
            resized_img = img.resize((180, 180), Image.Resampling.LANCZOS)
            
            # Save as PNG
            resized_img.save(output_path, 'PNG', optimize=True)
            print(f"Created iOS icon: {output_path}")
            print(f"New size: {resized_img.size}")
            
            return output_path
            
    except Exception as e:
        print(f"Error processing image: {e}")
        return None

if __name__ == "__main__":
    try:
        result = resize_logo_for_ios()
        if result:
            print("iOS icon created successfully!")
        else:
            print("Failed to create iOS icon.")
    except Exception as e:
        print(f"Error: {e}")