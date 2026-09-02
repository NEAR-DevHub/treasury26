-- Store user avatar images (data URLs or https URLs) alongside display names.
ALTER TABLE user_profiles
    ADD COLUMN avatar_url TEXT NULL;
