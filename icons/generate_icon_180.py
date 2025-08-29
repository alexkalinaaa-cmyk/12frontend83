#!/usr/bin/env python3
"""
Generate 180x180 icon for iOS PWA
"""
from PIL import Image, ImageDraw, ImageFont
import os

def create_icon_180():
    size = 180
    
    # Create image with gradient background
    img = Image.new('RGB', (size, size), color='#111827')
    draw = ImageDraw.Draw(img)
    
    # Create gradient effect (simple approximation)
    for y in range(size):
        alpha = y / size
        r = int(30 + (17 - 30) * alpha)    # 1e -> 11
        g = int(64 + (24 - 64) * alpha)    # 40 -> 18  
        b = int(175 + (39 - 175) * alpha)  # af -> 27
        color = f"#{r:02x}{g:02x}{b:02x}"
        draw.line([(0, y), (size, y)], fill=color)
    
    # Add subtle border
    border_width = max(1, int(size * 0.01))
    margin = int(size * 0.02)
    draw.rectangle(
        [margin, margin, size - margin, size - margin],
        outline="rgba(255,255,255,76)",  # 30% opacity white
        width=border_width
    )
    
    # Add main JL text
    try:
        font_size = int(size * 0.35)
        # Try to use a system font
        try:
            font = ImageFont.truetype("arial.ttf", font_size)
        except:
            try:
                font = ImageFont.truetype("/System/Library/Fonts/Arial.ttf", font_size)
            except:
                font = ImageFont.load_default()
        
        text = "JL"
        bbox = draw.textbbox((0, 0), text, font=font)
        text_width = bbox[2] - bbox[0]
        text_height = bbox[3] - bbox[1]
        
        x = (size - text_width) // 2 + 4  # Shift 4px right for better iOS positioning
        y = int(size * 0.45) - text_height // 2
        
        draw.text((x, y), text, fill="white", font=font)
    except Exception as e:
        print(f"Font error: {e}, using basic text")
        # Fallback without custom font
        draw.text((size//2 - 20 + 4, size//2 - 20), "JL", fill="white")  # Shift 4px right
    
    # Add pen icon
    pen_color = "#60a5fa"
    pen_width = max(1, int(size * 0.025))
    
    # Pen line
    x1, y1 = int(size * 0.25), int(size * 0.75)
    x2, y2 = int(size * 0.45), int(size * 0.65)
    draw.line([x1, y1, x2, y2], fill=pen_color, width=pen_width)
    
    # Pen tip (circle)
    tip_radius = int(size * 0.025)
    draw.ellipse([x2-tip_radius, y2-tip_radius, x2+tip_radius, y2+tip_radius], 
                 fill=pen_color)
    
    # Add document icon
    doc_x = int(size * 0.55)
    doc_y = int(size * 0.65)
    doc_w = int(size * 0.18)
    doc_h = int(size * 0.22)
    doc_line_width = max(1, int(size * 0.02))
    
    # Document rectangle
    draw.rectangle([doc_x, doc_y, doc_x + doc_w, doc_y + doc_h], 
                   outline=pen_color, width=doc_line_width)
    
    # Document lines
    line_width = max(1, int(size * 0.008))
    for i in range(3):
        line_y = int(size * (0.70 + i * 0.04))
        line_x1 = int(size * 0.58)
        line_x2 = int(size * 0.70)
        draw.line([line_x1, line_y, line_x2, line_y], fill=pen_color, width=line_width)
    
    # Save the image
    output_path = os.path.join(os.path.dirname(__file__), 'icon-180.png')
    img.save(output_path, 'PNG')
    print(f"Generated {output_path}")
    
    return output_path

if __name__ == "__main__":
    try:
        create_icon_180()
        print("Icon generated successfully!")
    except Exception as e:
        print(f"Error generating icon: {e}")