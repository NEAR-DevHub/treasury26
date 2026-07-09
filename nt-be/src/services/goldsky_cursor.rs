use sqlx::PgPool;

#[derive(Debug, Clone)]
pub struct GoldskyCursor {
    pub last_processed_id: String,
    pub last_processed_block: i64,
}

pub async fn load_goldsky_cursor(
    app_pool: &PgPool,
    goldsky_pool: &PgPool,
    consumer_name: &str,
) -> Result<GoldskyCursor, sqlx::Error> {
    let row = sqlx::query_as::<_, (String, i64)>(
        "SELECT last_processed_id, last_processed_block FROM goldsky_cursors WHERE consumer_name = $1",
    )
    .bind(consumer_name)
    .fetch_optional(app_pool)
    .await?;

    if let Some((id, block)) = row {
        return Ok(GoldskyCursor {
            last_processed_id: id,
            last_processed_block: block,
        });
    }

    let latest: Option<(String, i64)> = sqlx::query_as(
        "SELECT id, trigger_block_height FROM indexed_dao_outcomes ORDER BY trigger_block_height DESC, id DESC LIMIT 1",
    )
    .fetch_optional(goldsky_pool)
    .await?;

    match latest {
        Some((id, block)) => {
            tracing::info!(
                consumer_name = consumer_name,
                block = block,
                "seeding Goldsky cursor from latest sink row"
            );
            save_goldsky_cursor(app_pool, consumer_name, &id, block).await?;
            Ok(GoldskyCursor {
                last_processed_id: id,
                last_processed_block: block,
            })
        }
        None => Ok(GoldskyCursor {
            last_processed_id: String::new(),
            last_processed_block: 0,
        }),
    }
}

pub async fn save_goldsky_cursor(
    app_pool: &PgPool,
    consumer_name: &str,
    last_id: &str,
    last_block: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO goldsky_cursors (consumer_name, last_processed_id, last_processed_block, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (consumer_name) DO UPDATE SET
           last_processed_id = EXCLUDED.last_processed_id,
           last_processed_block = EXCLUDED.last_processed_block,
           updated_at = NOW()",
    )
    .bind(consumer_name)
    .bind(last_id)
    .bind(last_block)
    .execute(app_pool)
    .await?;
    Ok(())
}
