import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { auth } from '@/app/(auth)/auth';

// Initialize S3 client
// Ensure AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and S3_BUCKET_NAME are in your .env
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME!;

// Use Blob instead of File since File is not available in Node.js environment
const FileSchema = z.object({
  file: z
    .instanceof(Blob)
    .refine((file) => file.size <= 5 * 1024 * 1024, {
      message: 'File size should be less than 5MB',
    })
    // Update the file type based on the kind of files you want to accept
    .refine((file) => ['image/jpeg', 'image/png'].includes(file.type), {
      message: 'File type should be JPEG or PNG',
    }),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (request.body === null) {
    return new Response('Request body is empty', { status: 400 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as Blob;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const validatedFile = FileSchema.safeParse({ file });

    if (!validatedFile.success) {
      const errorMessage = validatedFile.error.errors
        .map((error) => error.message)
        .join(', ');

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    // Get filename from formData since Blob doesn't have name property
    const filename = (formData.get('file') as File).name;
    const fileBuffer = await file.arrayBuffer();

    try {
      // Ensure environment variables for S3 are loaded and available
      if (!process.env.AWS_REGION || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !S3_BUCKET_NAME) {
        console.error('S3 configuration missing in environment variables.');
        return NextResponse.json({ error: 'Server configuration error for file uploads.' }, { status: 500 });
      }

      const putObjectParams = {
        Bucket: S3_BUCKET_NAME,
        Key: `uploads/${filename}`, // Added 'uploads/' prefix for organization
        Body: Buffer.from(fileBuffer), // Convert ArrayBuffer to Buffer
        ContentType: file.type,
        ACL: 'public-read' as const, // As const for ACL type safety
      };

      await s3Client.send(new PutObjectCommand(putObjectParams));

      // Construct the public URL
      const fileUrl = `https://${S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/uploads/${encodeURIComponent(filename)}`;

      // Mimic Vercel Blob's response structure
      return NextResponse.json({
        url: fileUrl,
        pathname: `uploads/${filename}`, // Reflect the key used in S3
        contentType: file.type,
        contentDisposition: `inline; filename="${filename}"`
      });
    } catch (error) {
      console.error('S3 Upload failed:', error);
      return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to process request' },
      { status: 500 },
    );
  }
}
