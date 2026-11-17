-- R2-comments-mentions: email when @username is used in a map comment.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'comment-mentioned';
